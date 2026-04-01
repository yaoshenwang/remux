import SwiftUI
import RemuxKit

/// Main content view: sidebar + tab bar + terminal/inspect area.
struct MainContentView: View {
    @Environment(RemuxState.self) private var state
    @State private var showInspect = false

    var body: some View {
        NavigationSplitView {
            SidebarView()
        } detail: {
            if case .connected = state.connectionStatus {
                VStack(spacing: 0) {
                    TabBarView()

                    if showInspect {
                        HSplitView {
                            TerminalContainerView()
                                .frame(minWidth: 300)
                            InspectView()
                                .frame(minWidth: 250, idealWidth: 350)
                        }
                    } else {
                        TerminalContainerView()
                    }
                }
                .toolbar {
                    ToolbarItem(placement: .automatic) {
                        Button(action: { showInspect.toggle() }) {
                            Image(systemName: showInspect ? "doc.text.fill" : "doc.text")
                        }
                        .help("Toggle Inspect (⌘I)")
                        .keyboardShortcut("i", modifiers: .command)
                    }
                }
            } else {
                ConnectionView()
            }
        }
        .navigationSplitViewColumnWidth(min: 180, ideal: 220, max: 300)
    }
}
