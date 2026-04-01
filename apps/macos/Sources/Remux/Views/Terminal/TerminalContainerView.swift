import SwiftUI
import RemuxKit

/// Container connecting GhosttyNativeTerminalView to RemuxState.
/// Data flow:
///   Remote PTY → WebSocket → RemuxState → processOutput() → ghostty Metal render
///   User types → ghostty io_write_cb → onWrite → WebSocket → Remote PTY
struct TerminalContainerView: View {
    @Environment(RemuxState.self) private var state
    @State private var terminalCoordinator: GhosttyNativeTerminalView.Coordinator?

    var body: some View {
        GhosttyNativeTerminalView(
            onWrite: { data in
                // User typed in terminal → send to remote PTY via WebSocket
                state.sendTerminalData(data)
            },
            onResize: { cols, rows in
                state.sendTerminalInput("{\"type\":\"resize\",\"cols\":\(cols),\"rows\":\(rows)}")
            },
            onBell: {
                // TODO: trigger notification
            },
            onTitle: { title in
                NSApp.mainWindow?.title = "Remux — \(title)"
            }
        )
        .onReceive(NotificationCenter.default.publisher(for: .remuxTerminalData)) { notification in
            // Remote PTY data arrived → feed into ghostty for rendering
            if let data = notification.userInfo?["data"] as? Data,
               let coordinator = terminalCoordinator {
                coordinator.terminalView?.processOutput(data)
            }
        }
    }
}
