import Testing
import Foundation
@testable import RemuxKit

@Suite("Protocol Models")
struct ProtocolModelsTests {

    @Test("Decode auth_ok envelope")
    func decodeAuthOkEnvelope() throws {
        let json = """
        {
            "v": 1,
            "type": "auth_ok",
            "domain": "core",
            "emittedAt": "2026-04-01T00:00:00Z",
            "source": "server",
            "requestId": null,
            "payload": {
                "capabilities": {
                    "envelope": true,
                    "inspectV2": true,
                    "deviceTrust": true
                }
            }
        }
        """
        let data = Data(json.utf8)
        let envelope = try JSONDecoder().decode(RemuxEnvelope<AuthOkPayload>.self, from: data)
        #expect(envelope.domain == "core")
        #expect(envelope.type == "auth_ok")
        #expect(envelope.version == 1)
        #expect(envelope.payload.capabilities.envelope == true)
        #expect(envelope.payload.capabilities.inspectV2 == true)
        #expect(envelope.payload.capabilities.deviceTrust == true)
    }

    @Test("Decode workspace state")
    func decodeWorkspaceState() throws {
        let json = """
        {
            "session": "main",
            "tabs": [
                {
                    "index": 0,
                    "name": "zsh",
                    "active": true,
                    "isFullscreen": false,
                    "hasBell": false,
                    "panes": [
                        {
                            "id": "pane-1",
                            "focused": true,
                            "title": "zsh",
                            "command": null,
                            "cwd": "/Users/test",
                            "rows": 24,
                            "cols": 80,
                            "x": 0,
                            "y": 0
                        }
                    ]
                }
            ],
            "activeTabIndex": 0
        }
        """
        let data = Data(json.utf8)
        let state = try JSONDecoder().decode(WorkspaceState.self, from: data)
        #expect(state.session == "main")
        #expect(state.tabs.count == 1)
        #expect(state.tabs[0].name == "zsh")
        #expect(state.tabs[0].panes[0].id == "pane-1")
        #expect(state.tabs[0].panes[0].cols == 80)
    }

    @Test("Decode inspect snapshot")
    func decodeInspectSnapshot() throws {
        let json = """
        {
            "descriptor": {
                "scope": "tab",
                "source": "state_tracker",
                "precision": "precise",
                "staleness": "fresh",
                "capturedAt": "2026-04-01T00:00:00Z",
                "paneId": null,
                "tabIndex": 0,
                "totalItems": 3
            },
            "items": [
                {
                    "type": "output",
                    "content": "$ ls",
                    "lineNumber": 1,
                    "timestamp": "2026-04-01T00:00:00Z",
                    "paneId": "pane-1",
                    "highlights": null
                }
            ],
            "cursor": null,
            "truncated": false
        }
        """
        let data = Data(json.utf8)
        let snapshot = try JSONDecoder().decode(InspectSnapshot.self, from: data)
        #expect(snapshot.descriptor.scope == "tab")
        #expect(snapshot.descriptor.precision == "precise")
        #expect(snapshot.items.count == 1)
        #expect(snapshot.items[0].content == "$ ls")
        #expect(snapshot.truncated == false)
    }
}

@Suite("Message Router")
struct MessageRouterTests {

    @Test("Route workspace state message")
    func routeStateMessage() throws {
        let router = MessageRouter()
        let json = """
        {"v":1,"type":"state","domain":"runtime","emittedAt":"2026-04-01T00:00:00Z","source":"server","payload":{"sessions":[{"name":"main","tabs":[{"id":7,"title":"zsh","ended":false,"clients":1,"restored":false}],"createdAt":1712000000000}],"clients":[{"clientId":"c1","role":"active","session":"main","tabId":7}]}}
        """
        let result = router.route(json)
        guard case .workspaceSnapshot(let snapshot) = result else {
            Issue.record("Expected .workspaceSnapshot, got \(String(describing: result))")
            return
        }
        #expect(snapshot.sessions.count == 1)
        #expect(snapshot.sessions[0].name == "main")
        #expect(snapshot.sessions[0].tabs[0].id == 7)
    }

    @Test("Route legacy state message")
    func routeLegacyStateMessage() throws {
        let router = MessageRouter()
        let json = """
        {"type":"state","session":"dev","tabs":[],"activeTabIndex":0}
        """
        let result = router.route(json)
        guard case .workspaceSnapshot(let snapshot) = result else {
            Issue.record("Expected .workspaceSnapshot, got \(String(describing: result))")
            return
        }
        #expect(snapshot.sessions.first?.name == "dev")
        #expect(snapshot.sessions.first?.tabs.isEmpty == true)
    }

    @Test("Route role_changed message")
    func routeRoleChanged() throws {
        let router = MessageRouter()
        let json = """
        {"v":1,"type":"role_changed","domain":"core","emittedAt":"","source":"server","payload":{"role":"observer"}}
        """
        let result = router.route(json)
        guard case .roleChanged(let role) = result else {
            Issue.record("Expected .roleChanged")
            return
        }
        #expect(role == "observer")
    }

    @Test("Route unknown message type returns .unknown")
    func routeUnknownType() throws {
        let router = MessageRouter()
        let json = """
        {"type":"future_message","foo":"bar"}
        """
        let result = router.route(json)
        guard case .unknown(let type, _) = result else {
            Issue.record("Expected .unknown")
            return
        }
        #expect(type == "future_message")
    }

    @Test("Invalid JSON returns nil")
    func routeInvalidJSON() throws {
        let router = MessageRouter()
        let result = router.route("not json")
        #expect(result == nil)
    }

    @Test("Route bootstrap message")
    func routeBootstrapMessage() throws {
        let router = MessageRouter()
        let json = """
        {"v":1,"type":"bootstrap","domain":"core","emittedAt":"2026-04-01T00:00:00Z","source":"server","payload":{"sessions":[{"name":"default","tabs":[{"id":1,"title":"shell","ended":false,"clients":1,"restored":false}],"createdAt":1712000000000}],"clients":[{"clientId":"c1","role":"active","session":"default","tabId":1}]}}
        """
        let result = router.route(json)
        guard case .workspaceSnapshot(let snapshot) = result else {
            Issue.record("Expected .workspaceSnapshot")
            return
        }
        #expect(snapshot.sessions.first?.tabs.first?.title == "shell")
        #expect(snapshot.clients.first?.clientId == "c1")
    }

    @Test("Route current inspect result")
    func routeCurrentInspectResult() throws {
        let router = MessageRouter()
        let json = """
        {"v":1,"type":"inspect_result","domain":"runtime","emittedAt":"2026-04-01T00:00:00Z","source":"server","payload":{"text":"first\\nsecond","meta":{"session":"default","tabId":7,"tabTitle":"shell","cols":80,"rows":24,"timestamp":1712000000000}}}
        """
        let result = router.route(json)
        guard case .inspectResult(let snapshot) = result else {
            Issue.record("Expected .inspectResult")
            return
        }
        #expect(snapshot.items.count == 2)
        #expect(snapshot.items[0].content == "first")
        #expect(snapshot.descriptor.tabIndex == 7)
    }
}
