import SwiftUI
import RemuxKit

/// Container connecting GhosttyNativeTerminalView to RemuxState via TerminalRelay.
/// Data flow:
///   Remote PTY → WebSocket → RemuxState → relay.writeToTerminal() → socket → nc stdout → ghostty Metal render
///   User types → ghostty → nc stdin → socket → relay.onDataFromClient → state.sendTerminalData() → WebSocket → remote PTY
struct TerminalContainerView: View {
    @Environment(RemuxState.self) private var state
    @State private var terminalView: GhosttyNativeView?
    @State private var relay = TerminalRelay()

    var body: some View {
        GhosttyNativeTerminalView(
            socketPath: relay.socketPath,
            viewRef: $terminalView,
            onResize: { cols, rows in
                state.sendJSON(["type": "resize", "cols": cols, "rows": rows])
            },
            onBell: {},
            onTitle: { title in
                NSApp.mainWindow?.title = "Remux — \(title)"
            }
        )
        .onReceive(NotificationCenter.default.publisher(for: .remuxTerminalData)) { notification in
            if let data = notification.userInfo?["data"] as? Data {
                relay.writeToTerminal(data)
            }
        }
        .onAppear {
            relay.onDataFromClient = { data in
                state.sendTerminalData(data)
            }
            relay.start()
        }
        .onDisappear {
            relay.stop()
        }
    }
}
