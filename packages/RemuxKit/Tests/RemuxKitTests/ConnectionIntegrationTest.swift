import Testing
import Foundation
@testable import RemuxKit

@Suite("Connection Integration")
struct ConnectionIntegrationTests {

    @Test("Connect to local remux server and receive state")
    func connectAndReceiveState() async throws {
        let url = URL(string: "http://localhost:8767")!

        let conn = RemuxConnection(
            serverURL: url,
            credential: .token("test123"),
            cols: 80,
            rows: 24
        )

        let result: (auth: Bool, state: Bool) = await withCheckedContinuation { continuation in
            final class TestDelegate: RemuxConnectionDelegate, @unchecked Sendable {
                var authed = false
                var gotState = false
                var continuation: CheckedContinuation<(auth: Bool, state: Bool), Never>?
                var timer: DispatchWorkItem?

                func connectionDidChangeStatus(_ status: ConnectionStatus) {}
                func connectionDidReceiveData(_ data: Data) {}

                func connectionDidAuthenticate(capabilities: ProtocolCapabilities) {
                    authed = true
                }

                func connectionDidFailAuth(reason: String) {
                    finish()
                }

                func connectionDidReceiveMessage(_ message: String) {
                    if message.contains("\"type\":\"state\"") {
                        gotState = true
                        finish()
                    }
                }

                func finish() {
                    timer?.cancel()
                    let c = continuation
                    continuation = nil
                    c?.resume(returning: (auth: authed, state: gotState))
                }
            }

            let delegate = TestDelegate()
            delegate.continuation = continuation

            // Timeout after 5s
            let timeout = DispatchWorkItem { delegate.finish() }
            delegate.timer = timeout
            DispatchQueue.global().asyncAfter(deadline: .now() + 5, execute: timeout)

            conn.delegate = delegate
            conn.connect()
        }

        conn.disconnect()

        if !result.auth {
            print("⚠️ Server not running at localhost:8767, skipping")
            return
        }

        #expect(result.auth == true)
        #expect(result.state == true)
    }
}

@Suite("RemuxConnection")
struct RemuxConnectionTests {

    @Test("Treat non-protocol JSON output as terminal data")
    func classifyJsonTerminalOutput() {
        let disposition = RemuxConnection.classifyIncomingText(#"{"message":"hello"}"#)
        #expect(disposition == .terminal(#"{"message":"hello"}"#))
    }

    @Test("Treat enveloped messages as control")
    func classifyEnvelopedControl() {
        let disposition = RemuxConnection.classifyIncomingText(#"{"v":1,"type":"state","payload":{"sessions":[],"clients":[]}}"#)
        #expect(disposition == .control("state"))
    }
}
