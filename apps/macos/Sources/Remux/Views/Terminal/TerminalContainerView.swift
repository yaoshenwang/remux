import SwiftUI
import RemuxKit

/// Container connecting GhosttyNativeTerminalView to RemuxState via TerminalRelay.
/// Data flow:
///   Remote PTY -> WebSocket -> RemuxState -> relay.writeToTerminal() -> socket -> nc stdout -> ghostty Metal render
///   User types -> ghostty -> nc stdin -> socket -> relay.onDataFromClient -> state.sendTerminalData() -> WebSocket -> remote PTY
struct TerminalContainerView: View {
    let leafID: UUID?

    @Environment(RemuxState.self) private var state
    @State private var terminalView: GhosttyNativeView?
    @State private var relay = TerminalRelay()
    @State private var windowNumber: Int?

    // Search state
    @State private var searchVisible = false
    @State private var searchText = ""
    @State private var searchTotal = 0
    @State private var searchSelected = -1

    init(leafID: UUID? = nil) {
        self.leafID = leafID
    }

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
                    view.updateSearch(query)
                    if query.isEmpty {
                        searchTotal = 0
                        searchSelected = -1
                    }
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
                    terminalView?.updateSearch("")
                }
            )

            WindowObserver { window in
                windowNumber = window?.windowNumber
            }
            .frame(width: 0, height: 0)
        }
        .onReceive(NotificationCenter.default.publisher(for: .remuxTerminalData)) { notification in
            if let data = notification.userInfo?["data"] as? Data {
                relay.writeToTerminal(data)
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .remuxWindowCommand)) { notification in
            guard leafID == nil,
                  let command = WindowCommand(notification: notification),
                  command.action == .findInTerminal,
                  command.matches(windowNumber: windowNumber) else {
                return
            }
            openSearch()
        }
        .onReceive(NotificationCenter.default.publisher(for: .remuxTerminalCommand)) { notification in
            guard let command = TerminalCommand(notification: notification),
                  command.action == .showSearch,
                  command.matches(windowNumber: windowNumber, leafID: leafID) else {
                return
            }
            openSearch()
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

    private func openSearch() {
        searchVisible = true
    }
}
