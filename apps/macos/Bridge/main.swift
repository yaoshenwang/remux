// remux-bridge: Relay between local PTY (stdin/stdout) and Remux server WebSocket.
// Ghostty forks this process as the terminal command; stdin/stdout become the PTY slave ends.
//
// Environment variables:
//   REMUX_URL      - WebSocket URL (e.g. ws://localhost:3000/ws)
//   REMUX_TOKEN    - Authentication token
//   REMUX_TAB_ID   - Tab ID to attach to (optional; if absent, uses attach_first)
//   REMUX_SESSION  - Session name (optional; for attach_first)

import Foundation
#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

// MARK: - Configuration

struct BridgeConfig {
    let url: URL
    let token: String
    let tabId: Int?
    let session: String?

    static func fromEnvironment() -> BridgeConfig? {
        guard let urlString = ProcessInfo.processInfo.environment["REMUX_URL"],
              let url = URL(string: urlString) else {
            fputs("remux-bridge: REMUX_URL not set or invalid\n", stderr)
            return nil
        }
        guard let token = ProcessInfo.processInfo.environment["REMUX_TOKEN"], !token.isEmpty else {
            fputs("remux-bridge: REMUX_TOKEN not set\n", stderr)
            return nil
        }
        let tabId = ProcessInfo.processInfo.environment["REMUX_TAB_ID"].flatMap { Int($0) }
        let session = ProcessInfo.processInfo.environment["REMUX_SESSION"]
        return BridgeConfig(url: url, token: token, tabId: tabId, session: session)
    }
}

// MARK: - Terminal size

func terminalSize() -> (cols: Int, rows: Int) {
    var ws = winsize()
    if ioctl(STDIN_FILENO, TIOCGWINSZ, &ws) == 0 {
        return (Int(ws.ws_col), Int(ws.ws_row))
    }
    return (80, 24)
}

// MARK: - Bridge

final class RemuxBridge: NSObject, URLSessionWebSocketDelegate, @unchecked Sendable {

    private let config: BridgeConfig
    private var session: URLSession!
    private var task: URLSessionWebSocketTask?
    private var authenticated = false
    private var running = true
    private let stdinQueue = DispatchQueue(label: "remux.bridge.stdin")
    private let reconnectDelay: [TimeInterval] = [1, 2, 4, 8, 15, 30]
    private var reconnectAttempt = 0

    init(config: BridgeConfig) {
        self.config = config
        super.init()
        self.session = URLSession(
            configuration: .default,
            delegate: self,
            delegateQueue: OperationQueue()
        )
    }

    func start() {
        setupSignalHandlers()
        connect()
        dispatchMain()
    }

    // MARK: - Connection

    private func connect() {
        var request = URLRequest(url: config.url)
        request.timeoutInterval = 10
        task = session.webSocketTask(with: request)
        task?.resume()
    }

    func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didOpenWithProtocol protocol: String?
    ) {
        reconnectAttempt = 0
        sendAuth()
    }

    func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
        reason: Data?
    ) {
        authenticated = false
        scheduleReconnect()
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didCompleteWithError error: (any Error)?
    ) {
        if error != nil {
            authenticated = false
            scheduleReconnect()
        }
    }

    private func scheduleReconnect() {
        guard running else { return }
        let delay = reconnectDelay[min(reconnectAttempt, reconnectDelay.count - 1)]
        reconnectAttempt += 1
        fputs("remux-bridge: reconnecting in \(delay)s (attempt \(reconnectAttempt))\n", stderr)
        DispatchQueue.global().asyncAfter(deadline: .now() + delay) { [weak self] in
            self?.connect()
        }
    }

    // MARK: - Authentication

    private func sendAuth() {
        let size = terminalSize()
        let auth: [String: Any] = [
            "type": "auth",
            "token": config.token,
            "cols": size.cols,
            "rows": size.rows,
            "capabilities": [
                "envelope": true,
                "inspectV2": true,
                "deviceTrust": true,
            ],
        ]
        sendJSON(auth)
        receiveMessage()
    }

    // MARK: - Message handling

    private func receiveMessage() {
        task?.receive { [weak self] result in
            guard let self, self.running else { return }
            switch result {
            case .success(let message):
                switch message {
                case .string(let text):
                    self.handleTextMessage(text)
                case .data(let data):
                    self.writeToStdout(data)
                @unknown default:
                    break
                }
                self.receiveMessage()
            case .failure:
                self.authenticated = false
                self.scheduleReconnect()
            }
        }
    }

    private func handleTextMessage(_ text: String) {
        guard let data = text.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = json["type"] as? String ?? (json["payload"] as? [String: Any])?["type"] as? String
        else {
            // Not JSON — treat as raw terminal data
            if let d = text.data(using: .utf8) {
                writeToStdout(d)
            }
            return
        }

        // Handle envelope format (v:1)
        let payload = json["payload"] as? [String: Any]
        let effectiveType: String
        if json["v"] as? Int == 1, let t = json["type"] as? String {
            effectiveType = t
        } else {
            effectiveType = type
        }

        switch effectiveType {
        case "auth_ok":
            authenticated = true
            sendAttach()
            startStdinRelay()
        case "auth_error":
            let reason = payload?["reason"] as? String ?? json["reason"] as? String ?? "unknown"
            fputs("remux-bridge: auth failed: \(reason)\n", stderr)
            exit(1)
        case "ping":
            sendJSON(["type": "pong"])
        case "attached":
            // Successfully attached to a tab
            break
        case "state", "bootstrap":
            // Server state update — ignore in bridge (app handles this)
            break
        case "role_changed":
            let role = payload?["role"] as? String ?? json["role"] as? String ?? ""
            if role == "observer" {
                fputs("remux-bridge: demoted to observer\n", stderr)
            }
        default:
            // Unknown control message — ignore
            break
        }
    }

    private func sendAttach() {
        let size = terminalSize()
        if let tabId = config.tabId {
            sendJSON([
                "type": "attach_tab",
                "tabId": tabId,
                "cols": size.cols,
                "rows": size.rows,
            ])
        } else {
            var msg: [String: Any] = [
                "type": "attach_first",
                "cols": size.cols,
                "rows": size.rows,
            ]
            if let s = config.session {
                msg["session"] = s
            }
            sendJSON(msg)
        }
    }

    // MARK: - Data relay

    private func startStdinRelay() {
        stdinQueue.async { [weak self] in
            let bufferSize = 4096
            let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: bufferSize)
            defer { buffer.deallocate() }

            // Set stdin to raw mode
            var originalTermios = termios()
            tcgetattr(STDIN_FILENO, &originalTermios)
            var raw = originalTermios
            cfmakeraw(&raw)
            tcsetattr(STDIN_FILENO, TCSANOW, &raw)

            while self?.running == true {
                let n = read(STDIN_FILENO, buffer, bufferSize)
                if n <= 0 {
                    // EOF or error — ghostty closed the PTY
                    self?.running = false
                    exit(0)
                }
                let data = Data(bytes: buffer, count: n)
                if let text = String(data: data, encoding: .utf8) {
                    self?.task?.send(.string(text)) { _ in }
                } else {
                    self?.task?.send(.data(data)) { _ in }
                }
            }

            // Restore terminal
            tcsetattr(STDIN_FILENO, TCSANOW, &originalTermios)
        }
    }

    private func writeToStdout(_ data: Data) {
        data.withUnsafeBytes { ptr in
            if let base = ptr.baseAddress {
                let _ = write(STDOUT_FILENO, base, ptr.count)
            }
        }
    }

    // MARK: - Resize (SIGWINCH)

    func handleResize() {
        guard authenticated else { return }
        let size = terminalSize()
        sendJSON([
            "type": "resize",
            "cols": size.cols,
            "rows": size.rows,
        ])
    }

    // MARK: - Signals

    private func setupSignalHandlers() {
        // SIGWINCH — terminal resize
        let winchSource = DispatchSource.makeSignalSource(signal: SIGWINCH, queue: .global())
        winchSource.setEventHandler { [weak self] in
            self?.handleResize()
        }
        signal(SIGWINCH, SIG_IGN)
        winchSource.resume()
        // Keep source alive
        objc_setAssociatedObject(self, "winchSource", winchSource, .OBJC_ASSOCIATION_RETAIN)

        // SIGTERM / SIGINT — clean shutdown
        for sig in [SIGTERM, SIGINT] {
            let source = DispatchSource.makeSignalSource(signal: sig, queue: .global())
            source.setEventHandler { [weak self] in
                self?.running = false
                self?.task?.cancel(with: .goingAway, reason: nil)
                exit(0)
            }
            signal(sig, SIG_IGN)
            source.resume()
            objc_setAssociatedObject(self, "sig\(sig)", source, .OBJC_ASSOCIATION_RETAIN)
        }
    }

    // MARK: - Helpers

    private func sendJSON(_ dict: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: dict),
              let text = String(data: data, encoding: .utf8) else { return }
        task?.send(.string(text)) { _ in }
    }
}

// MARK: - Entry point

guard let config = BridgeConfig.fromEnvironment() else {
    fputs("Usage: REMUX_URL=ws://host/ws REMUX_TOKEN=token remux-bridge\n", stderr)
    exit(1)
}

let bridge = RemuxBridge(config: config)
bridge.start()
