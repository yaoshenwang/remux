import SwiftUI
import RemuxKit

/// Container connecting GhosttyNativeTerminalView to RemuxState.
/// Data flow:
///   Remote PTY → WebSocket → RemuxState → processOutput() → ghostty Metal render
///   User types → ghostty io_write_cb → onWrite → WebSocket → Remote PTY
struct TerminalContainerView: View {
    @Environment(RemuxState.self) private var state
    @State private var terminalView: GhosttyNativeView?

    var body: some View {
        GhosttyNativeTerminalView(
            viewRef: $terminalView,
            onWrite: { data in
                state.sendTerminalData(data)
            },
            onResize: { cols, rows in
                state.sendTerminalInput("{\"type\":\"resize\",\"cols\":\(cols),\"rows\":\(rows)}")
            },
            onBell: {
                // TODO: E07-B-24 notification system
            },
            onTitle: { title in
                NSApp.mainWindow?.title = "Remux — \(title)"
            }
        )
        .onReceive(NotificationCenter.default.publisher(for: .remuxTerminalData)) { notification in
            if let data = notification.userInfo?["data"] as? Data {
                terminalView?.processOutput(data)
            }
        }
    }
}
