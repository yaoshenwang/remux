import Foundation

/// Bidirectional relay between a Unix domain socket and the WebSocket connection.
/// Ghostty spawns `nc -U <socketPath>` as its "shell" process.
/// Data flow:
///   Remote PTY → WebSocket → onDataFromServer → socket → nc stdout → ghostty renders
///   User types → ghostty → nc stdin → socket → onDataFromClient → WebSocket → remote PTY
@MainActor
final class TerminalRelay {

    let socketPath: String
    var onDataFromClient: ((Data) -> Void)?  // user keystrokes → send to WebSocket

    private var serverSocket: Int32 = -1
    private var clientSocket: Int32 = -1
    private var readSource: DispatchSourceRead?
    private let queue = DispatchQueue(label: "remux.terminal-relay")

    init() {
        socketPath = NSTemporaryDirectory() + "remux-relay-\(ProcessInfo.processInfo.processIdentifier)-\(UUID().uuidString.prefix(8)).sock"
    }

    deinit {
        stop()
    }

    /// Start listening on the Unix socket. Call before creating the ghostty surface.
    func start() {
        // Create Unix domain socket
        serverSocket = socket(AF_UNIX, SOCK_STREAM, 0)
        guard serverSocket >= 0 else { return }

        // Remove stale socket file
        unlink(socketPath)

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = socketPath.utf8CString
        pathBytes.withUnsafeBufferPointer { buf in
            withUnsafeMutableBytes(of: &addr.sun_path) { rawPath in
                let count = min(buf.count, rawPath.count)
                rawPath.copyBytes(from: UnsafeRawBufferPointer(buf).prefix(count))
            }
        }

        let bindResult = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockPtr in
                Darwin.bind(serverSocket, sockPtr, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard bindResult == 0 else {
            close(serverSocket); serverSocket = -1; return
        }

        listen(serverSocket, 1)

        // Accept connection async (nc will connect when ghostty spawns)
        let fd = serverSocket
        queue.async { [weak self] in
            let client = accept(fd, nil, nil)
            guard client >= 0 else { return }
            DispatchQueue.main.async {
                self?.clientSocket = client
                self?.startReading()
            }
        }
    }

    /// Write data to the socket → nc → ghostty PTY stdout → rendered on screen.
    func writeToTerminal(_ data: Data) {
        guard clientSocket >= 0 else { return }
        data.withUnsafeBytes { ptr in
            guard let base = ptr.baseAddress else { return }
            _ = send(clientSocket, base, ptr.count, 0)
        }
    }

    /// Stop the relay and clean up.
    nonisolated func stop() {
        MainActor.assumeIsolated {
            readSource?.cancel()
            readSource = nil
            if clientSocket >= 0 { close(clientSocket); clientSocket = -1 }
            if serverSocket >= 0 { close(serverSocket); serverSocket = -1 }
            unlink(socketPath)
        }
    }

    // MARK: - Private

    private func startReading() {
        guard clientSocket >= 0 else { return }
        let source = DispatchSource.makeReadSource(fileDescriptor: clientSocket, queue: queue)
        source.setEventHandler { [weak self] in
            guard let self else { return }
            var buf = [UInt8](repeating: 0, count: 65536)
            let n = recv(self.clientSocket, &buf, buf.count, 0)
            if n > 0 {
                let data = Data(buf[0..<n])
                DispatchQueue.main.async {
                    self.onDataFromClient?(data)
                }
            } else if n == 0 {
                // nc disconnected
                source.cancel()
            }
        }
        source.setCancelHandler { [weak self] in
            guard let self else { return }
            DispatchQueue.main.async {
                self.clientSocket = -1
            }
        }
        source.resume()
        readSource = source
    }
}
