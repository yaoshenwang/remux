import Foundation
import RemuxKit

/// Unix socket control API for scriptable automation.
/// Listens on ~/Library/Application Support/com.remux/remux.sock
/// Protocol: JSON-RPC — request: {"method": "...", "params": {...}, "id": 1}
///                       response: {"result": {...}, "id": 1} or {"error": "...", "id": 1}
///
/// Supported methods: list_tabs, create_tab, close_tab, write_input,
///                    get_state, list_sessions, switch_tab
///
/// Adapted from tmux control-mode / neovim --listen socket API patterns.
final class SocketController: @unchecked Sendable {

    private let socketPath: String
    private var serverFD: Int32 = -1
    private var isRunning = false
    private let queue = DispatchQueue(label: "remux.socket-controller")
    private weak var state: RemuxState?

    init(state: RemuxState) {
        self.state = state

        let appSupport = FileManager.default.urls(
            for: .applicationSupportDirectory, in: .userDomainMask
        ).first!
        let dir = appSupport.appendingPathComponent("com.remux", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        socketPath = dir.appendingPathComponent("remux.sock").path
    }

    /// Start listening on the Unix socket.
    func start() {
        guard !isRunning else { return }
        isRunning = true

        // Remove stale socket
        unlink(socketPath)

        serverFD = socket(AF_UNIX, SOCK_STREAM, 0)
        guard serverFD >= 0 else {
            NSLog("[remux] SocketController: failed to create socket")
            isRunning = false
            return
        }

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
                Darwin.bind(serverFD, sockPtr, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }

        guard bindResult == 0 else {
            NSLog("[remux] SocketController: bind failed: %d", errno)
            close(serverFD)
            serverFD = -1
            isRunning = false
            return
        }

        listen(serverFD, 1)
        NSLog("[remux] SocketController: listening on %@", socketPath)

        queue.async { [weak self] in
            self?.acceptLoop()
        }
    }

    /// Stop the socket controller and clean up.
    func stop() {
        isRunning = false
        if serverFD >= 0 {
            close(serverFD)
            serverFD = -1
        }
        unlink(socketPath)
        NSLog("[remux] SocketController: stopped")
    }

    // MARK: - Accept loop

    private func acceptLoop() {
        while isRunning {
            let clientFD = accept(serverFD, nil, nil)
            guard clientFD >= 0 else {
                if isRunning { NSLog("[remux] SocketController: accept failed") }
                break
            }
            handleClient(fd: clientFD)
            close(clientFD)
        }
    }

    // MARK: - Client handling

    /// Thread-safe result container using a class marked @unchecked Sendable.
    private final class RPCResultBox: @unchecked Sendable {
        var resultJSON: String?
        var errorMsg: String?
    }

    private func handleClient(fd: Int32) {
        var buffer = [UInt8](repeating: 0, count: 65536)
        let n = recv(fd, &buffer, buffer.count, 0)
        guard n > 0 else { return }

        let data = Data(buffer[0..<n])
        guard let _ = String(data: data, encoding: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            sendResponse(fd: fd, error: "Invalid JSON", id: nil)
            return
        }

        let method = json["method"] as? String ?? ""
        let requestID = json["id"]

        // Extract params as Sendable strings before crossing isolation boundary
        let tabIDParam = (json["params"] as? [String: Any])?["tabId"] as? String
        let textParam = (json["params"] as? [String: Any])?["text"] as? String
        let indexParam = (json["params"] as? [String: Any])?["index"] as? Int

        let sem = DispatchSemaphore(value: 0)
        let box = RPCResultBox()

        DispatchQueue.main.async { [weak self, box] in
            defer { sem.signal() }
            guard let self, let state = self.state else {
                box.errorMsg = "State unavailable"
                return
            }

            switch method {
            case "list_tabs":
                let tabs: [[String: Any]] = state.tabs.map { tab in
                    [
                        "index": tab.index,
                        "name": tab.name,
                        "active": tab.active,
                        "paneCount": tab.panes.count,
                    ]
                }
                let dict: [String: Any] = ["tabs": tabs]
                if let d = try? JSONSerialization.data(withJSONObject: dict),
                   let s = String(data: d, encoding: .utf8) {
                    box.resultJSON = s
                }

            case "create_tab":
                state.createTab()
                box.resultJSON = "{\"ok\":true}"

            case "close_tab":
                if let tabID = tabIDParam {
                    state.closeTab(id: tabID)
                    box.resultJSON = "{\"ok\":true}"
                } else {
                    box.errorMsg = "Missing tabId parameter"
                }

            case "write_input":
                if let text = textParam {
                    state.sendTerminalInput(text)
                    box.resultJSON = "{\"ok\":true}"
                } else {
                    box.errorMsg = "Missing text parameter"
                }

            case "get_state":
                let dict: [String: Any] = [
                    "session": state.currentSession,
                    "activeTabIndex": state.activeTabIndex,
                    "tabCount": state.tabs.count,
                    "role": state.clientRole,
                    "connected": state.connectionStatus == .connected,
                ]
                if let d = try? JSONSerialization.data(withJSONObject: dict),
                   let s = String(data: d, encoding: .utf8) {
                    box.resultJSON = s
                }

            case "list_sessions":
                let dict: [String: Any] = ["session": state.currentSession]
                if let d = try? JSONSerialization.data(withJSONObject: dict),
                   let s = String(data: d, encoding: .utf8) {
                    box.resultJSON = s
                }

            case "switch_tab":
                if let tabID = tabIDParam {
                    state.switchTab(id: tabID)
                    box.resultJSON = "{\"ok\":true}"
                } else if let index = indexParam,
                          index < state.tabs.count,
                          let pane = state.tabs[index].panes.first {
                    state.switchTab(id: pane.id)
                    box.resultJSON = "{\"ok\":true}"
                } else {
                    box.errorMsg = "Missing or invalid tabId/index parameter"
                }

            default:
                box.errorMsg = "Unknown method: \(method)"
            }
        }

        sem.wait()

        if let error = box.errorMsg {
            sendResponse(fd: fd, error: error, id: requestID)
        } else {
            sendResponseRaw(fd: fd, json: box.resultJSON ?? "{\"ok\":true}", id: requestID)
        }
    }

    // MARK: - Response helpers

    private func sendResponse(fd: Int32, error: String, id: Any?) {
        var dict: [String: Any] = ["error": error]
        if let id { dict["id"] = id }
        guard let data = try? JSONSerialization.data(withJSONObject: dict),
              var response = String(data: data, encoding: .utf8) else { return }
        response += "\n"
        response.withCString { ptr in
            _ = send(fd, ptr, strlen(ptr), 0)
        }
    }

    private func sendResponseRaw(fd: Int32, json: String, id: Any?) {
        // Wrap the pre-serialized JSON result into a response envelope
        var response: String
        if let id {
            let idStr: String
            if let intID = id as? Int {
                idStr = "\(intID)"
            } else if let strID = id as? String {
                idStr = "\"\(strID)\""
            } else {
                idStr = "null"
            }
            response = "{\"result\":\(json),\"id\":\(idStr)}\n"
        } else {
            response = "{\"result\":\(json)}\n"
        }
        response.withCString { ptr in
            _ = send(fd, ptr, strlen(ptr), 0)
        }
    }
}
