import SwiftUI
import RemuxKit

/// Container that connects GhosttyNativeTerminalView to RemuxState.
/// Handles PTY data forwarding and resize notifications.
struct TerminalContainerView: View {
    @Environment(RemuxState.self) private var state

    var body: some View {
        GhosttyNativeTerminalView(
            onResize: { cols, rows in
                // Send resize to server
                state.sendTerminalInput("{\"type\":\"resize\",\"cols\":\(cols),\"rows\":\(rows)}")
            },
            onBell: {
                // TODO: trigger notification via E07-B-24
            },
            onTitle: { title in
                // Update window title
                NSApp.mainWindow?.title = "Remux — \(title)"
            }
        )
        .onReceive(NotificationCenter.default.publisher(for: .remuxTerminalData)) { notification in
            // TODO: forward PTY data to GhosttyNativeView.write()
            // This requires a reference to the NSView — will be handled via Coordinator pattern
        }
    }
}
