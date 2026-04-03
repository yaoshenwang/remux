// RemuxTabBridge: Bridges RemuxSessionManager (server state) with remux TabManager (UI state).
// Translates server tab/session events into TabManager workspace operations.

import Foundation
import Combine

final class RemuxTabBridge: ObservableObject {

    let sessionManager: RemuxSessionManager
    private var cancellables = Set<AnyCancellable>()

    /// Map from server tab ID to local Workspace UUID
    @Published var tabIdToWorkspaceId: [Int: UUID] = [:]
    /// Reverse map
    @Published var workspaceIdToTabId: [UUID: Int] = [:]

    /// Callback to create a workspace in TabManager
    var createWorkspace: ((_ tabId: Int, _ title: String, _ bridgeCommand: String, _ bridgeEnv: [String: String]) -> UUID?)?
    /// Callback to remove a workspace from TabManager
    var removeWorkspace: ((_ workspaceId: UUID) -> Void)?
    /// Callback to select a workspace in TabManager
    var selectWorkspace: ((_ workspaceId: UUID) -> Void)?

    init(sessionManager: RemuxSessionManager) {
        self.sessionManager = sessionManager
        setupCallbacks()
    }

    private func setupCallbacks() {
        // When server sends bootstrap, sync all tabs
        sessionManager.onBootstrap = { [weak self] sessions in
            self?.syncFromServer(sessions: sessions)
        }

        // When server state updates, reconcile with local state
        sessionManager.onStateUpdate = { [weak self] sessions, _ in
            self?.reconcile(sessions: sessions)
        }

        // When a new tab is created and we get its ID
        sessionManager.onTabCreated = { [weak self] tabId, session in
            self?.materializeTab(tabId: tabId, title: "Tab \(tabId)", session: session)
        }

        sessionManager.onRoleChanged = { [weak self] role in
            // Could update UI to show observer badge, disable input, etc.
            _ = self
        }
    }

    // MARK: - Server → Local sync

    /// Initial sync: create local workspaces for all server tabs
    private func syncFromServer(sessions: [RemuxServerSession]) {
        for session in sessions {
            for tab in session.tabs {
                if tabIdToWorkspaceId[tab.id] == nil {
                    materializeTab(tabId: tab.id, title: tab.title, session: session.name)
                }
            }
        }
    }

    /// Reconcile: add missing tabs, remove stale ones
    private func reconcile(sessions: [RemuxServerSession]) {
        let serverTabIds = Set(sessions.flatMap { $0.tabs.map(\.id) })
        let localTabIds = Set(tabIdToWorkspaceId.keys)

        // Add tabs that exist on server but not locally
        for session in sessions {
            for tab in session.tabs {
                if tabIdToWorkspaceId[tab.id] == nil {
                    materializeTab(tabId: tab.id, title: tab.title, session: session.name)
                }
            }
        }

        // Remove tabs that no longer exist on server
        for tabId in localTabIds.subtracting(serverTabIds) {
            if let workspaceId = tabIdToWorkspaceId[tabId] {
                removeWorkspace?(workspaceId)
                tabIdToWorkspaceId.removeValue(forKey: tabId)
                workspaceIdToTabId.removeValue(forKey: workspaceId)
            }
        }
    }

    /// Create a local workspace backed by a remux-bridge process
    @discardableResult
    private func materializeTab(tabId: Int, title: String, session: String) -> UUID? {
        guard tabIdToWorkspaceId[tabId] == nil else {
            return tabIdToWorkspaceId[tabId]
        }

        let bridgeEnv = sessionManager.bridgeEnvironment(tabId: tabId, session: session)
        guard let bridgePath = sessionManager.bridgePath else {
            print("[RemuxTabBridge] bridge executable not found")
            return nil
        }

        guard let workspaceId = createWorkspace?(tabId, title, bridgePath, bridgeEnv) else {
            return nil
        }

        tabIdToWorkspaceId[tabId] = workspaceId
        workspaceIdToTabId[workspaceId] = tabId
        return workspaceId
    }

    // MARK: - Local → Server commands

    /// Request new tab creation on server. Returns when server confirms.
    func requestNewTab(session: String? = nil) async throws -> Int {
        let tabId = try await sessionManager.createTab(session: session)
        return tabId
    }

    /// Request tab close on server
    func requestCloseTab(workspaceId: UUID) {
        guard let tabId = workspaceIdToTabId[workspaceId] else { return }
        sessionManager.closeTab(id: tabId)
        // Don't remove locally yet — wait for server state update
    }

    /// Request tab rename on server
    func requestRenameTab(workspaceId: UUID, title: String) {
        guard let tabId = workspaceIdToTabId[workspaceId] else { return }
        sessionManager.renameTab(id: tabId, title: title)
    }

    // MARK: - Cleanup

    func disconnectAll() {
        for (_, workspaceId) in tabIdToWorkspaceId {
            removeWorkspace?(workspaceId)
        }
        tabIdToWorkspaceId.removeAll()
        workspaceIdToTabId.removeAll()
        sessionManager.disconnect()
    }
}
