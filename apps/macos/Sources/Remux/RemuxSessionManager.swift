// RemuxSessionManager: Manages the control WebSocket connection to a Remux server.
// Handles authentication, state sync, and tab lifecycle.
// Drives TabManager UI from server-provided state.

import Foundation
import Combine

// MARK: - Connection State

enum RemuxConnectionStatus: Equatable {
    case disconnected
    case connecting
    case authenticating
    case connected
    case reconnecting(attempt: Int)
}

// MARK: - Protocol Models (matching Remux envelope v:1)

struct RemuxServerTab: Codable, Equatable, Identifiable {
    let id: Int
    let title: String
    let ended: Bool
    let clients: Int
    let restored: Bool
}

struct RemuxServerSession: Codable, Equatable {
    let name: String
    let tabs: [RemuxServerTab]
    let createdAt: Int
}

struct RemuxClientInfo: Codable, Equatable {
    let clientId: String
    let role: String
    let session: String?
    let tabId: Int?
}

struct RemuxBootstrap: Codable {
    let sessions: [RemuxServerSession]
    let clients: [RemuxClientInfo]
}

struct RemuxAttachedPayload: Codable {
    let tabId: Int
    let session: String
    let clientId: String
    let role: String
}

// MARK: - Session Manager

final class RemuxSessionManager: NSObject, ObservableObject, URLSessionWebSocketDelegate, @unchecked Sendable {

    // MARK: Published state

    @Published var status: RemuxConnectionStatus = .disconnected
    @Published var sessions: [RemuxServerSession] = []
    @Published var clients: [RemuxClientInfo] = []
    @Published var clientRole: String = "observer"
    @Published var currentSession: String = "main"
    @Published var currentTabId: Int?
    @Published var errorMessage: String?

    // MARK: Connection config

    private(set) var serverURL: URL?
    private(set) var token: String?
    private var urlSession: URLSession!
    private var wsTask: URLSessionWebSocketTask?
    private var reconnectAttempt = 0
    private let reconnectDelays: [TimeInterval] = [1, 2, 4, 8, 15, 30]

    // MARK: Callbacks for TabManager integration

    var onBootstrap: (([RemuxServerSession]) -> Void)?
    var onStateUpdate: (([RemuxServerSession], [RemuxClientInfo]) -> Void)?
    var onAttached: ((RemuxAttachedPayload) -> Void)?
    var onRoleChanged: ((String) -> Void)?
    var onTabCreated: ((Int, String) -> Void)? // tabId, session

    // MARK: Pending operations

    private var pendingTabCreation: CheckedContinuation<Int, Error>?

    // MARK: Init

    override init() {
        super.init()
        self.urlSession = URLSession(
            configuration: .default,
            delegate: self,
            delegateQueue: OperationQueue()
        )
    }

    // MARK: - Connection lifecycle

    func connect(url: URL, token: String) {
        self.serverURL = url
        self.token = token
        self.reconnectAttempt = 0
        self.errorMessage = nil
        doConnect()
    }

    func disconnect() {
        wsTask?.cancel(with: .goingAway, reason: nil)
        wsTask = nil
        DispatchQueue.main.async {
            self.status = .disconnected
            self.sessions = []
            self.clients = []
        }
    }

    private func doConnect() {
        guard let url = serverURL else { return }
        DispatchQueue.main.async { self.status = .connecting }
        var request = URLRequest(url: url)
        request.timeoutInterval = 10
        wsTask = urlSession.webSocketTask(with: request)
        wsTask?.resume()
    }

    // MARK: - URLSessionWebSocketDelegate

    func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didOpenWithProtocol protocol: String?
    ) {
        reconnectAttempt = 0
        DispatchQueue.main.async { self.status = .authenticating }
        sendAuth()
    }

    func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
        reason: Data?
    ) {
        scheduleReconnect()
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didCompleteWithError error: (any Error)?
    ) {
        if error != nil {
            scheduleReconnect()
        }
    }

    private func scheduleReconnect() {
        guard serverURL != nil, token != nil else { return }
        let delay = reconnectDelays[min(reconnectAttempt, reconnectDelays.count - 1)]
        reconnectAttempt += 1
        DispatchQueue.main.async {
            self.status = .reconnecting(attempt: self.reconnectAttempt)
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + delay) { [weak self] in
            self?.doConnect()
        }
    }

    // MARK: - Auth

    private func sendAuth() {
        guard let token else { return }
        let auth: [String: Any] = [
            "type": "auth",
            "token": token,
            "cols": 80,
            "rows": 24,
            "capabilities": [
                "envelope": true,
                "inspectV2": true,
                "deviceTrust": true,
            ],
        ]
        sendJSON(auth)
        receiveLoop()
    }

    // MARK: - Message receive loop

    private func receiveLoop() {
        wsTask?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let message):
                switch message {
                case .string(let text):
                    self.handleMessage(text)
                case .data:
                    break // Control connection doesn't receive binary data
                @unknown default:
                    break
                }
                self.receiveLoop()
            case .failure:
                self.scheduleReconnect()
            }
        }
    }

    // MARK: - Message routing

    private func handleMessage(_ text: String) {
        guard let data = text.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }

        let messageType: String
        let payload: [String: Any]

        if let v = json["v"] as? Int, v == 1,
           let t = json["type"] as? String {
            messageType = t
            payload = json["payload"] as? [String: Any] ?? [:]
        } else if let t = json["type"] as? String {
            messageType = t
            payload = json
        } else {
            return
        }

        switch messageType {
        case "auth_ok":
            DispatchQueue.main.async {
                self.status = .connected
                self.errorMessage = nil
            }

        case "auth_error":
            let reason = payload["reason"] as? String ?? "unknown"
            DispatchQueue.main.async {
                self.status = .disconnected
                self.errorMessage = "Auth failed: \(reason)"
            }

        case "bootstrap":
            handleBootstrap(payload)

        case "state":
            handleState(payload)

        case "attached":
            handleAttached(payload)

        case "role_changed":
            let role = payload["role"] as? String ?? "observer"
            DispatchQueue.main.async {
                self.clientRole = role
                self.onRoleChanged?(role)
            }

        case "ping":
            sendJSON(["type": "pong"])

        default:
            break
        }
    }

    private func handleBootstrap(_ payload: [String: Any]) {
        guard let payloadData = try? JSONSerialization.data(withJSONObject: payload),
              let bootstrap = try? JSONDecoder().decode(RemuxBootstrap.self, from: payloadData) else { return }

        DispatchQueue.main.async {
            self.sessions = bootstrap.sessions
            self.clients = bootstrap.clients
            // Find our client info
            if let myClient = bootstrap.clients.first(where: { $0.session == nil && $0.tabId == nil }) {
                self.clientRole = myClient.role
            }
            self.onBootstrap?(bootstrap.sessions)
        }
    }

    private func handleState(_ payload: [String: Any]) {
        guard let sessionsData = payload["sessions"],
              let jsonData = try? JSONSerialization.data(withJSONObject: sessionsData),
              let sessions = try? JSONDecoder().decode([RemuxServerSession].self, from: jsonData) else { return }

        let clientsData = payload["clients"]
        let clients: [RemuxClientInfo] = {
            guard let cd = clientsData,
                  let jd = try? JSONSerialization.data(withJSONObject: cd),
                  let decoded = try? JSONDecoder().decode([RemuxClientInfo].self, from: jd) else { return [] }
            return decoded
        }()

        DispatchQueue.main.async {
            let oldTabIds = Set(self.sessions.flatMap { $0.tabs.map(\.id) })
            self.sessions = sessions
            self.clients = clients

            // Detect newly created tabs (for pending createTab operations)
            let newTabIds = Set(sessions.flatMap { $0.tabs.map(\.id) })
            let addedIds = newTabIds.subtracting(oldTabIds)
            if let newId = addedIds.first, let continuation = self.pendingTabCreation {
                self.pendingTabCreation = nil
                let sessionName = sessions.first(where: { $0.tabs.contains(where: { $0.id == newId }) })?.name ?? "main"
                continuation.resume(returning: newId)
                self.onTabCreated?(newId, sessionName)
            }

            self.onStateUpdate?(sessions, clients)
        }
    }

    private func handleAttached(_ payload: [String: Any]) {
        guard let payloadData = try? JSONSerialization.data(withJSONObject: payload),
              let attached = try? JSONDecoder().decode(RemuxAttachedPayload.self, from: payloadData) else { return }

        DispatchQueue.main.async {
            self.currentTabId = attached.tabId
            self.currentSession = attached.session
            self.clientRole = attached.role
            self.onAttached?(attached)
        }
    }

    // MARK: - Control commands

    func createTab(session: String? = nil) async throws -> Int {
        return try await withCheckedThrowingContinuation { continuation in
            self.pendingTabCreation = continuation
            var msg: [String: Any] = ["type": "new_tab"]
            if let s = session {
                msg["session"] = s
            }
            self.sendJSON(msg)

            // Timeout after 10 seconds
            DispatchQueue.global().asyncAfter(deadline: .now() + 10) { [weak self] in
                if let continuation = self?.pendingTabCreation {
                    self?.pendingTabCreation = nil
                    continuation.resume(throwing: NSError(
                        domain: "RemuxSessionManager",
                        code: -1,
                        userInfo: [NSLocalizedDescriptionKey: "Tab creation timed out"]
                    ))
                }
            }
        }
    }

    func closeTab(id: Int) {
        sendJSON(["type": "close_tab", "tabId": id])
    }

    func renameTab(id: Int, title: String) {
        sendJSON(["type": "rename_tab", "tabId": id, "title": title])
    }

    func switchSession(name: String) {
        sendJSON(["type": "switch_session", "name": name])
    }

    func createSession(name: String) {
        sendJSON(["type": "new_session", "name": name])
    }

    func deleteSession(name: String) {
        sendJSON(["type": "delete_session", "name": name])
    }

    func requestControl() {
        sendJSON(["type": "request_control"])
    }

    func releaseControl() {
        sendJSON(["type": "release_control"])
    }

    // MARK: - Bridge environment helper

    /// Returns environment variables for a remux-bridge process targeting a specific tab.
    func bridgeEnvironment(tabId: Int, session: String? = nil) -> [String: String] {
        guard let url = serverURL, let token else { return [:] }
        var env: [String: String] = [
            "REMUX_URL": url.absoluteString,
            "REMUX_TOKEN": token,
            "REMUX_TAB_ID": String(tabId),
        ]
        if let s = session ?? (currentSession.isEmpty ? nil : currentSession) {
            env["REMUX_SESSION"] = s
        }
        return env
    }

    /// Path to the remux-bridge executable bundled with the app.
    var bridgePath: String? {
        Bundle.main.resourceURL?.appendingPathComponent("bin/remux-bridge").path
            ?? ProcessInfo.processInfo.environment["REMUX_BRIDGE_PATH"]
    }

    // MARK: - Credential persistence

    static let urlKey = "remux-server-url"
    static let tokenKey = "remux-server-token"

    func saveCredentials() {
        guard let url = serverURL, let token else { return }
        UserDefaults.standard.set(url.absoluteString, forKey: Self.urlKey)
        // Store token in Keychain for security
        let data = token.data(using: .utf8) ?? Data()
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: Self.tokenKey,
            kSecAttrService as String: "com.remux.macos",
        ]
        SecItemDelete(query as CFDictionary)
        var add = query
        add[kSecValueData as String] = data
        SecItemAdd(add as CFDictionary, nil)
    }

    static func loadCredentials() -> (url: URL, token: String)? {
        guard let urlString = UserDefaults.standard.string(forKey: urlKey),
              let url = URL(string: urlString) else { return nil }

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: tokenKey,
            kSecAttrService as String: "com.remux.macos",
            kSecReturnData as String: true,
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess,
              let data = result as? Data,
              let token = String(data: data, encoding: .utf8) else { return nil }

        return (url, token)
    }

    // MARK: - Helpers

    private func sendJSON(_ dict: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: dict),
              let text = String(data: data, encoding: .utf8) else { return }
        wsTask?.send(.string(text)) { _ in }
    }
}
