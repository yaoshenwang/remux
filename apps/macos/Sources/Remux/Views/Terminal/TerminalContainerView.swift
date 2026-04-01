import SwiftUI
import RemuxKit

/// Container connecting GhosttyNativeTerminalView to RemuxState via TerminalRelay.
/// Data flow:
///   Remote PTY -> WebSocket -> RemuxState -> relay.writeToTerminal() -> socket -> nc stdout -> ghostty Metal render
///   User types -> ghostty -> nc stdin -> socket -> relay.onDataFromClient -> state.sendTerminalData() -> WebSocket -> remote PTY
struct TerminalContainerView: View {
    @Environment(RemuxState.self) private var state
    @State private var terminalView: GhosttyNativeView?
    @State private var relay = TerminalRelay()

    // Search state
    @State private var searchVisible = false
    @State private var searchText = ""
    @State private var searchTotal = 0
    @State private var searchSelected = -1

    var body: some View {
        ZStack(alignment: .topTrailing) {
            GhosttyNativeTerminalView(
                socketPath: relay.socketPath,
                viewRef: $terminalView,
                onResize: { cols, rows in
                    state.sendJSON(["type": "resize", "cols": cols, "rows": rows])
                },
                onBell: {},
                onTitle: { title in
                    NSApp.mainWindow?.title = "Remux — \(title)"
                },
                onSearchStart: { needle in
                    searchVisible = true
                    if let needle, !needle.isEmpty {
                        searchText = needle
                    }
                },
                onSearchEnd: {
                    searchVisible = false
                    searchText = ""
                    searchTotal = 0
                    searchSelected = -1
                },
                onSearchTotal: { total in
                    searchTotal = total
                },
                onSearchSelected: { selected in
                    searchSelected = selected
                }
            )

            SurfaceSearchOverlay(
                isVisible: $searchVisible,
                searchText: $searchText,
                totalMatches: $searchTotal,
                selectedMatch: $searchSelected,
                onSearch: { query in
                    guard let view = terminalView else { return }
                    if query.isEmpty {
                        searchTotal = 0
                        searchSelected = -1
                    }
                    // Ghostty search is triggered by typing into the search bar,
                    // which sends the text via binding_action
                    let action = "search:\(query)"
                    view.sendText("")  // ensure surface has focus
                    _ = action  // search is driven by the overlay text field
                },
                onNext: {
                    terminalView?.searchForward()
                },
                onPrevious: {
                    terminalView?.searchBackward()
                },
                onClose: {
                    searchTotal = 0
                    searchSelected = -1
                }
            )
        }
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
