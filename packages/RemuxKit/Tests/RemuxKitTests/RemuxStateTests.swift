import Testing
import Foundation
@testable import RemuxKit

@Suite("RemuxState")
struct RemuxStateTests {

    @Test("Initial state is disconnected")
    @MainActor
    func initialState() {
        let state = RemuxState()
        #expect(state.connectionStatus == .disconnected)
        #expect(state.currentSession == "")
        #expect(state.tabs.isEmpty)
        #expect(state.clientRole == "active")
    }

    @Test("Process workspace state message")
    @MainActor
    func processWorkspaceState() {
        let state = RemuxState()
        let json = """
        {"type":"state","session":"main","tabs":[{"index":0,"name":"zsh","active":true,"isFullscreen":false,"hasBell":false,"panes":[{"id":"p1","focused":true,"title":"zsh","command":null,"cwd":"/tmp","rows":24,"cols":80,"x":0,"y":0}]}],"activeTabIndex":0}
        """
        state.connectionDidReceiveMessage(json)
        #expect(state.currentSession == "main")
        #expect(state.tabs.count == 1)
        #expect(state.tabs[0].name == "zsh")
    }

    @Test("Process role_changed message")
    @MainActor
    func processRoleChanged() {
        let state = RemuxState()
        let json = """
        {"type":"role_changed","role":"observer"}
        """
        state.connectionDidReceiveMessage(json)
        #expect(state.clientRole == "observer")
    }

    @Test("Process inspect_result message")
    @MainActor
    func processInspectResult() {
        let state = RemuxState()
        let json = """
        {"type":"inspect_result","descriptor":{"scope":"tab","source":"state_tracker","precision":"precise","staleness":"fresh","capturedAt":"2026-04-01T00:00:00Z","paneId":null,"tabIndex":0,"totalItems":1},"items":[{"type":"output","content":"hello","lineNumber":1,"timestamp":"2026-04-01T00:00:00Z","paneId":"p1","highlights":null}],"cursor":null,"truncated":false}
        """
        state.connectionDidReceiveMessage(json)
        #expect(state.inspectSnapshot != nil)
        #expect(state.inspectSnapshot?.items.count == 1)
        #expect(state.inspectSnapshot?.items[0].content == "hello")
    }

    @Test("ConnectionStatus is Equatable")
    func statusEquatable() {
        #expect(ConnectionStatus.connected == ConnectionStatus.connected)
        #expect(ConnectionStatus.disconnected != ConnectionStatus.connected)
        #expect(ConnectionStatus.reconnecting(attempt: 1) == ConnectionStatus.reconnecting(attempt: 1))
        #expect(ConnectionStatus.reconnecting(attempt: 1) != ConnectionStatus.reconnecting(attempt: 2))
    }
}
