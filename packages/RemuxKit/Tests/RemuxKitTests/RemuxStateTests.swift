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
        {"type":"state","sessions":[{"name":"main","tabs":[{"id":11,"title":"zsh","ended":false,"clients":1,"restored":false}],"createdAt":1712000000000}],"clients":[]}
        """
        state.connectionDidReceiveMessage(json)
        #expect(state.currentSession == "main")
        #expect(state.tabs.count == 1)
        #expect(state.tabs[0].name == "zsh")
        #expect(state.tabs[0].panes[0].id == "11")
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
        {"type":"inspect_result","text":"hello","meta":{"session":"main","tabId":11,"tabTitle":"zsh","cols":80,"rows":24,"timestamp":1712000000000}}
        """
        state.connectionDidReceiveMessage(json)
        #expect(state.inspectSnapshot != nil)
        #expect(state.inspectSnapshot?.items.count == 1)
        #expect(state.inspectSnapshot?.items[0].content == "hello")
    }

    @Test("Attached message updates current tab and role")
    @MainActor
    func processAttached() {
        let state = RemuxState()
        state.connectionDidReceiveMessage("""
        {"type":"state","sessions":[{"name":"main","tabs":[{"id":11,"title":"zsh","ended":false,"clients":1,"restored":false}],"createdAt":1712000000000}],"clients":[]}
        """)
        state.connectionDidReceiveMessage("""
        {"type":"attached","tabId":11,"session":"main","clientId":"c1","role":"observer"}
        """)

        #expect(state.currentSession == "main")
        #expect(state.activeTabIndex == 11)
        #expect(state.clientRole == "observer")
        #expect(state.tabs.first?.active == true)
    }

    @Test("ConnectionStatus is Equatable")
    func statusEquatable() {
        #expect(ConnectionStatus.connected == ConnectionStatus.connected)
        #expect(ConnectionStatus.disconnected != ConnectionStatus.connected)
        #expect(ConnectionStatus.reconnecting(attempt: 1) == ConnectionStatus.reconnecting(attempt: 1))
        #expect(ConnectionStatus.reconnecting(attempt: 1) != ConnectionStatus.reconnecting(attempt: 2))
    }
}
