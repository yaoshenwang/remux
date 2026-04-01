import Foundation

/// Central state container for remux client.
/// Uses @Observable macro (ref: remodex's CodexService pattern).
/// All state updates happen on MainActor.
@Observable
@MainActor
public final class RemuxState {

    // MARK: - Connection

    public private(set) var connectionStatus: ConnectionStatus = .disconnected
    public private(set) var serverURL: URL?
    public private(set) var capabilities: ProtocolCapabilities?

    // MARK: - Workspace

    public private(set) var currentSession: String = ""
    public private(set) var tabs: [WorkspaceTab] = []
    public private(set) var activeTabIndex: Int = 0

    // MARK: - Client role

    public private(set) var clientRole: String = "active" // "active" or "observer"

    // MARK: - Inspect

    public private(set) var inspectSnapshot: InspectSnapshot?

    // MARK: - Devices

    public private(set) var devices: [DeviceInfo] = []

    // MARK: - Connection reference

    private var connection: RemuxConnection?
    private let router = MessageRouter()

    public init() {}

    // MARK: - Connection management

    public func connect(url: URL, credential: RemuxCredential) {
        serverURL = url
        let conn = RemuxConnection(serverURL: url, credential: credential)
        conn.delegate = self
        connection = conn
        conn.connect()
    }

    public func disconnect() {
        connection?.disconnect()
        connection = nil
    }

    // MARK: - Actions

    public func switchTab(id: String) {
        connection?.sendString("{\"type\":\"attach_tab\",\"tabId\":\"\(id)\"}")
    }

    public func createTab() {
        connection?.sendString("{\"type\":\"new_tab\"}")
    }

    public func closeTab(id: String) {
        connection?.sendString("{\"type\":\"close_tab\",\"tabId\":\"\(id)\"}")
    }

    public func renameTab(id: String, name: String) {
        let escaped = name.replacingOccurrences(of: "\"", with: "\\\"")
        connection?.sendString("{\"type\":\"rename_tab\",\"tabId\":\"\(id)\",\"name\":\"\(escaped)\"}")
    }

    public func createSession(name: String) {
        let escaped = name.replacingOccurrences(of: "\"", with: "\\\"")
        connection?.sendString("{\"type\":\"new_session\",\"name\":\"\(escaped)\"}")
    }

    public func deleteSession(name: String) {
        let escaped = name.replacingOccurrences(of: "\"", with: "\\\"")
        connection?.sendString("{\"type\":\"delete_session\",\"name\":\"\(escaped)\"}")
    }

    public func requestInspect(tabIndex: Int? = nil, query: String? = nil) {
        var dict: [String: Any] = ["type": "inspect"]
        if let idx = tabIndex { dict["tabIndex"] = idx }
        if let q = query { dict["query"] = q }
        if let data = try? JSONSerialization.data(withJSONObject: dict),
           let str = String(data: data, encoding: .utf8) {
            connection?.sendString(str)
        }
    }

    public func requestControl() {
        connection?.sendString("{\"type\":\"request_control\"}")
    }

    public func releaseControl() {
        connection?.sendString("{\"type\":\"release_control\"}")
    }

    public func sendTerminalInput(_ text: String) {
        connection?.sendString(text)
    }

    public func sendTerminalData(_ data: Data) {
        connection?.sendData(data)
    }

    // MARK: - Internal state updates

    fileprivate func updateConnectionStatus(_ status: ConnectionStatus) {
        connectionStatus = status
    }

    fileprivate func handleAuthenticated(capabilities: ProtocolCapabilities) {
        self.capabilities = capabilities
        connectionStatus = .connected
    }

    fileprivate func processMessage(_ text: String) {
        guard let routed = router.route(text) else { return }

        switch routed {
        case .state(let ws):
            currentSession = ws.session
            tabs = ws.tabs
            activeTabIndex = ws.activeTabIndex
        case .inspectResult(let snapshot):
            inspectSnapshot = snapshot
        case .roleChanged(let role):
            clientRole = role
        case .deviceList(let list):
            devices = list
        case .pairResult:
            // Handled by pairing UI flow
            break
        case .pushStatus:
            break
        case .error:
            break
        case .unknown:
            break
        }
    }
}

// MARK: - RemuxConnectionDelegate

extension RemuxState: @preconcurrency RemuxConnectionDelegate {

    public func connectionDidChangeStatus(_ status: ConnectionStatus) {
        updateConnectionStatus(status)
    }

    public func connectionDidReceiveMessage(_ message: String) {
        processMessage(message)
    }

    public func connectionDidReceiveData(_ data: Data) {
        NotificationCenter.default.post(
            name: .remuxTerminalData,
            object: nil,
            userInfo: ["data": data]
        )
    }

    public func connectionDidAuthenticate(capabilities: ProtocolCapabilities) {
        handleAuthenticated(capabilities: capabilities)
    }

    public func connectionDidFailAuth(reason: String) {
        connectionStatus = .disconnected
    }
}

// MARK: - Notifications

public extension Notification.Name {
    static let remuxTerminalData = Notification.Name("remuxTerminalData")
}
