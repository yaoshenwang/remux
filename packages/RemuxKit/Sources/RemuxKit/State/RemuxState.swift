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
    private var workspaceSnapshot = WorkspaceSnapshot(sessions: [], clients: [])
    private var clientId: String?
    private var currentTabId: Int?

    public init() {}

    // MARK: - Connection management

    public func connect(url: URL, credential: RemuxCredential) {
        connection?.disconnect()
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
        sendJSON(["type": "attach_tab", "tabId": Int(id) ?? id])
    }

    public func createTab() {
        var payload: [String: Any] = ["type": "new_tab"]
        if !currentSession.isEmpty {
            payload["session"] = currentSession
        }
        sendJSON(payload)
    }

    public func closeTab(id: String) {
        sendJSON(["type": "close_tab", "tabId": Int(id) ?? id])
    }

    public func renameTab(id: String, name: String) {
        sendJSON(["type": "rename_tab", "tabId": Int(id) ?? id, "title": name])
    }

    public func createSession(name: String) {
        sendJSON(["type": "new_session", "name": name])
    }

    public func deleteSession(name: String) {
        sendJSON(["type": "delete_session", "name": name])
    }

    public func requestInspect(tabIndex: Int? = nil, query: String? = nil) {
        if let tabId = tabIndex, tabId != currentTabId {
            sendJSON(["type": "attach_tab", "tabId": tabId])
        }
        var dict: [String: Any] = ["type": "inspect"]
        if let idx = tabIndex { dict["tabIndex"] = idx }
        if let q = query { dict["query"] = q }
        if let data = try? JSONSerialization.data(withJSONObject: dict),
           let str = String(data: data, encoding: .utf8) {
            connection?.sendString(str)
        }
    }

    public func requestControl() {
        sendJSON(["type": "request_control"])
    }

    public func releaseControl() {
        sendJSON(["type": "release_control"])
    }

    public func sendTerminalInput(_ text: String) {
        connection?.sendString(text)
    }

    /// Safe JSON message construction — prevents injection via string interpolation
    public func sendJSON(_ dict: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: dict),
              let str = String(data: data, encoding: .utf8) else { return }
        connection?.sendString(str)
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
        case .workspaceSnapshot(let snapshot):
            applyWorkspaceSnapshot(snapshot)
        case .attached(let attached):
            clientId = attached.clientId
            currentSession = attached.session
            currentTabId = attached.tabId
            clientRole = attached.role
            rebuildTabs()
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

    private func applyWorkspaceSnapshot(_ snapshot: WorkspaceSnapshot) {
        workspaceSnapshot = snapshot

        if let clientId,
           let client = snapshot.clients.first(where: { $0.clientId == clientId }) {
            currentSession = client.session ?? currentSession
            currentTabId = client.tabId ?? currentTabId
            clientRole = client.role
        } else if currentSession.isEmpty, let firstSession = snapshot.sessions.first?.name {
            currentSession = firstSession
        }

        rebuildTabs()
    }

    private func rebuildTabs() {
        let sessionSummary =
            workspaceSnapshot.sessions.first(where: { $0.name == currentSession })
            ?? workspaceSnapshot.sessions.first

        if currentSession.isEmpty, let sessionSummary {
            currentSession = sessionSummary.name
        }

        guard let sessionSummary else {
            tabs = []
            activeTabIndex = 0
            return
        }

        let activeTabId = currentTabId ?? sessionSummary.tabs.first?.id
        currentTabId = activeTabId
        activeTabIndex = activeTabId ?? 0
        tabs = sessionSummary.tabs.map { tab in
            let isActive = tab.id == activeTabId
            return WorkspaceTab(
                index: tab.id,
                name: tab.title,
                active: isActive,
                isFullscreen: false,
                hasBell: false,
                panes: [
                    WorkspacePane(
                        id: String(tab.id),
                        focused: isActive,
                        title: tab.title,
                        command: nil,
                        cwd: nil,
                        rows: 24,
                        cols: 80,
                        x: 0,
                        y: 0
                    )
                ]
            )
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
        // Auto-attach to first tab to start receiving PTY data
        connection?.sendString("{\"type\":\"attach_first\"}")
    }

    public func connectionDidFailAuth(reason: String) {
        connectionStatus = .disconnected
    }
}

// MARK: - Notifications

public extension Notification.Name {
    static let remuxTerminalData = Notification.Name("remuxTerminalData")
}
