import Foundation

/// Connection status for the remux server
public enum ConnectionStatus: Sendable {
    case disconnected
    case connecting
    case authenticating
    case connected
    case reconnecting(attempt: Int)
}

/// Credentials used to authenticate with the server
public enum RemuxCredential: Sendable {
    case token(String)
    case password(String)
    case resumeToken(String)
}

/// Delegate for connection events
public protocol RemuxConnectionDelegate: AnyObject, Sendable {
    func connectionDidChangeStatus(_ status: ConnectionStatus)
    func connectionDidReceiveMessage(_ message: String)
    func connectionDidReceiveData(_ data: Data)
    func connectionDidAuthenticate(capabilities: ProtocolCapabilities)
    func connectionDidFailAuth(reason: String)
}

/// WebSocket connection manager for a remux server.
/// Uses URLSessionWebSocketTask (no third-party dependencies).
/// Handles authentication, automatic reconnection with exponential backoff, and heartbeat.
public final class RemuxConnection: NSObject, @unchecked Sendable {

    public let serverURL: URL
    private let credential: RemuxCredential
    private let cols: Int
    private let rows: Int

    // Internals guarded by a lock for Sendable compliance
    private let lock = NSLock()
    private var _task: URLSessionWebSocketTask?
    private var _status: ConnectionStatus = .disconnected
    private var _reconnectAttempt: Int = 0
    private var _reconnectTimer: DispatchWorkItem?
    private var _heartbeatMissed: Int = 0
    private var _heartbeatTimer: Timer?
    private var _pendingMessages: [String] = []

    public weak var delegate: RemuxConnectionDelegate?

    private static let maxReconnectAttempts = 20
    private static let heartbeatTimeout: TimeInterval = 45
    private static let authTimeout: TimeInterval = 10

    private lazy var urlSession: URLSession = {
        URLSession(configuration: .default, delegate: nil, delegateQueue: nil)
    }()

    public init(serverURL: URL, credential: RemuxCredential, cols: Int = 80, rows: Int = 24) {
        self.serverURL = serverURL
        self.credential = credential
        self.cols = cols
        self.rows = rows
        super.init()
    }

    // MARK: - Public API

    public var status: ConnectionStatus {
        lock.lock()
        defer { lock.unlock() }
        return _status
    }

    /// Connect to the server. Initiates WebSocket connection and authentication.
    public func connect() {
        lock.lock()
        _reconnectAttempt = 0
        lock.unlock()
        startConnection()
    }

    /// Disconnect and stop reconnection attempts.
    public func disconnect() {
        lock.lock()
        _reconnectTimer?.cancel()
        _reconnectTimer = nil
        _reconnectAttempt = Self.maxReconnectAttempts // prevent reconnect
        let task = _task
        _task = nil
        lock.unlock()

        stopHeartbeatTimer()
        task?.cancel(with: .goingAway, reason: nil)
        setStatus(.disconnected)
    }

    /// Send a JSON-encodable message to the server.
    public func send<T: Encodable>(message: T) {
        guard let data = try? JSONEncoder().encode(message),
              let string = String(data: data, encoding: .utf8) else { return }
        sendString(string)
    }

    /// Send raw text message.
    public func sendString(_ string: String) {
        lock.lock()
        let task = _task
        lock.unlock()

        guard let task else {
            // Buffer messages during reconnection
            lock.lock()
            _pendingMessages.append(string)
            lock.unlock()
            return
        }
        task.send(.string(string)) { _ in }
    }

    /// Send raw binary data (e.g. user terminal input forwarded as-is).
    public func sendData(_ data: Data) {
        lock.lock()
        let task = _task
        lock.unlock()
        task?.send(.data(data)) { _ in }
    }

    // MARK: - Connection lifecycle

    private func startConnection() {
        setStatus(.connecting)

        // Build WebSocket URL: ws(s)://host:port/ws
        var components = URLComponents(url: serverURL, resolvingAgainstBaseURL: false)!
        // Convert http(s) to ws(s)
        if components.scheme == "http" { components.scheme = "ws" }
        else if components.scheme == "https" { components.scheme = "wss" }
        components.path = "/ws"
        guard let wsURL = components.url else { return }

        let task = urlSession.webSocketTask(with: wsURL)
        lock.lock()
        _task = task
        lock.unlock()

        task.resume()
        receiveLoop(task: task)
        authenticate(task: task)
    }

    private func authenticate(task: URLSessionWebSocketTask) {
        setStatus(.authenticating)

        var authDict: [String: Any] = [
            "type": "auth",
            "cols": cols,
            "rows": rows,
        ]

        // Declare capabilities
        authDict["capabilities"] = [
            "envelope": true,
            "inspectV2": true,
            "deviceTrust": true,
        ]

        switch credential {
        case .token(let t):
            authDict["token"] = t
        case .password(let p):
            authDict["token"] = ""
            authDict["password"] = p
        case .resumeToken(let rt):
            authDict["token"] = rt
        }

        if let data = try? JSONSerialization.data(withJSONObject: authDict),
           let string = String(data: data, encoding: .utf8) {
            task.send(.string(string)) { _ in }
        }

        // Auth timeout
        DispatchQueue.global().asyncAfter(deadline: .now() + Self.authTimeout) { [weak self] in
            guard let self else { return }
            self.lock.lock()
            let currentStatus = self._status
            self.lock.unlock()

            if case .authenticating = currentStatus {
                self.handleDisconnect()
            }
        }
    }

    // MARK: - Receive loop

    private func receiveLoop(task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            guard let self else { return }

            switch result {
            case .success(let message):
                switch message {
                case .string(let text):
                    self.handleTextMessage(text)
                case .data(let data):
                    self.delegate?.connectionDidReceiveData(data)
                @unknown default:
                    break
                }
                // Continue receiving
                self.receiveLoop(task: task)

            case .failure:
                self.handleDisconnect()
            }
        }
    }

    private func handleTextMessage(_ text: String) {
        // Check for auth response first
        if let data = text.data(using: .utf8),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {

            // Handle both envelope and legacy format
            let msgType: String?
            if let v = json["v"] as? Int, v >= 1 {
                msgType = json["type"] as? String
            } else {
                msgType = json["type"] as? String
            }

            switch msgType {
            case "auth_ok":
                handleAuthOk(json)
                return
            case "auth_error":
                let reason = json["reason"] as? String
                    ?? (json["payload"] as? [String: Any])?["reason"] as? String
                    ?? "Unknown error"
                delegate?.connectionDidFailAuth(reason: reason)
                return
            case "ping":
                // Respond to server heartbeat
                resetHeartbeatTimer()
                sendString("{\"type\":\"pong\"}")
                return
            default:
                break
            }
        }

        delegate?.connectionDidReceiveMessage(text)
    }

    private func handleAuthOk(_ json: [String: Any]) {
        // Parse capabilities from envelope or legacy format
        let capsDict: [String: Any]?
        if let payload = json["payload"] as? [String: Any] {
            capsDict = payload["capabilities"] as? [String: Any]
        } else {
            capsDict = json["capabilities"] as? [String: Any]
        }

        let capabilities = ProtocolCapabilities(
            envelope: capsDict?["envelope"] as? Bool ?? false,
            inspectV2: capsDict?["inspectV2"] as? Bool ?? false,
            deviceTrust: capsDict?["deviceTrust"] as? Bool ?? false
        )

        setStatus(.connected)

        lock.lock()
        _reconnectAttempt = 0
        let pending = _pendingMessages
        _pendingMessages.removeAll()
        lock.unlock()

        // Flush buffered messages
        for msg in pending {
            sendString(msg)
        }

        startHeartbeatTimer()
        delegate?.connectionDidAuthenticate(capabilities: capabilities)
    }

    // MARK: - Reconnection (exponential backoff, ref: remodex reconnection strategy)

    private func handleDisconnect() {
        lock.lock()
        let task = _task
        _task = nil
        let attempt = _reconnectAttempt
        lock.unlock()

        stopHeartbeatTimer()
        task?.cancel(with: .goingAway, reason: nil)

        guard attempt < Self.maxReconnectAttempts else {
            setStatus(.disconnected)
            return
        }

        let nextAttempt = attempt + 1
        lock.lock()
        _reconnectAttempt = nextAttempt
        lock.unlock()

        setStatus(.reconnecting(attempt: nextAttempt))

        // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s max
        let delay = min(pow(2.0, Double(attempt)), 30.0)
        let workItem = DispatchWorkItem { [weak self] in
            self?.startConnection()
        }

        lock.lock()
        _reconnectTimer = workItem
        lock.unlock()

        DispatchQueue.global().asyncAfter(deadline: .now() + delay, execute: workItem)
    }

    // MARK: - Heartbeat (E07-A-06)

    private func startHeartbeatTimer() {
        stopHeartbeatTimer()
        lock.lock()
        _heartbeatMissed = 0
        lock.unlock()

        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            let timer = Timer.scheduledTimer(withTimeInterval: Self.heartbeatTimeout, repeats: false) { [weak self] _ in
                // No ping received within timeout — force reconnect
                self?.handleDisconnect()
            }
            self.lock.lock()
            self._heartbeatTimer = timer
            self.lock.unlock()
        }
    }

    private func resetHeartbeatTimer() {
        // Called when we receive a ping — restart the timeout
        startHeartbeatTimer()
    }

    private func stopHeartbeatTimer() {
        lock.lock()
        let timer = _heartbeatTimer
        _heartbeatTimer = nil
        lock.unlock()
        DispatchQueue.main.async {
            timer?.invalidate()
        }
    }

    // MARK: - Status

    private func setStatus(_ status: ConnectionStatus) {
        lock.lock()
        _status = status
        lock.unlock()
        delegate?.connectionDidChangeStatus(status)
    }
}
