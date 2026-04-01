import SwiftUI
import RemuxKit

/// Main content view: sidebar + tab bar + split terminal/inspect area.
struct MainContentView: View {
    @Environment(RemuxState.self) private var state
    @State private var showInspect = false

    // Split pane state
    @State private var splitRoot: SplitNode = .leaf(SplitNode.LeafData(tabIndex: 0))
    @State private var focusedLeafID: UUID?

    var body: some View {
        NavigationSplitView {
            SidebarView()
        } detail: {
            if case .connected = state.connectionStatus {
                VStack(spacing: 0) {
                    TabBarView()

                    if showInspect {
                        HSplitView {
                            splitContent
                                .frame(minWidth: 300)
                            InspectView()
                                .frame(minWidth: 250, idealWidth: 350)
                        }
                    } else {
                        splitContent
                    }
                }
                .toolbar {
                    ToolbarItem(placement: .automatic) {
                        Button(action: { showInspect.toggle() }) {
                            Image(systemName: showInspect ? "doc.text.fill" : "doc.text")
                        }
                        .help("Toggle Inspect (\u{2318}I)")
                        .keyboardShortcut("i", modifiers: .command)
                    }
                }
            } else {
                ConnectionView()
            }
        }
        .navigationSplitViewColumnWidth(min: 180, ideal: 220, max: 300)
        .onAppear {
            // Set initial focused leaf
            if focusedLeafID == nil {
                focusedLeafID = splitRoot.allLeaves.first?.id
            }
        }
    }

    @ViewBuilder
    private var splitContent: some View {
        SplitView(
            node: splitRoot,
            focusedLeafID: $focusedLeafID,
            onSplit: { leafID, orientation in
                splitPane(leafID: leafID, orientation: orientation)
            },
            onClose: { leafID in
                closePane(leafID: leafID)
            },
            onRatioChange: { branchID, ratio in
                splitRoot = splitRoot.updateRatio(branchID: branchID, ratio: ratio)
            }
        )
    }

    // MARK: - Split operations

    /// Split the given (or focused) pane in the specified direction.
    func splitPane(leafID: UUID? = nil, orientation: SplitNode.Orientation) {
        let targetID = leafID ?? focusedLeafID ?? splitRoot.allLeaves.first?.id
        guard let targetID else { return }

        let newTabIndex = state.activeTabIndex
        splitRoot = splitRoot.split(
            leafID: targetID,
            orientation: orientation,
            newTabIndex: newTabIndex
        )

        // Focus the new pane
        if let newLeaves = splitRoot.allLeaves.last {
            focusedLeafID = newLeaves.id
        }
    }

    /// Close a specific pane.
    func closePane(leafID: UUID? = nil) {
        let targetID = leafID ?? focusedLeafID ?? splitRoot.allLeaves.last?.id
        guard let targetID else { return }

        // Don't close the last pane
        guard splitRoot.allLeaves.count > 1 else { return }

        // Move focus before removing
        if focusedLeafID == targetID {
            focusedLeafID = splitRoot.previousLeaf(before: targetID)?.id
                ?? splitRoot.allLeaves.first?.id
        }

        if let newRoot = splitRoot.removeLeaf(id: targetID) {
            splitRoot = newRoot
        }
    }

    /// Focus the next pane.
    func focusNextPane() {
        guard let current = focusedLeafID,
              let next = splitRoot.nextLeaf(after: current) else { return }
        focusedLeafID = next.id
    }

    /// Focus the previous pane.
    func focusPreviousPane() {
        guard let current = focusedLeafID,
              let prev = splitRoot.previousLeaf(before: current) else { return }
        focusedLeafID = prev.id
    }

    /// Get the current split layout as a snapshot for persistence.
    var splitLayoutSnapshot: SplitNodeSnapshot {
        splitRoot.toSnapshot()
    }

    /// Restore split layout from a snapshot.
    mutating func restoreSplitLayout(_ snapshot: SplitNodeSnapshot) {
        splitRoot = SplitNode.fromSnapshot(snapshot)
        focusedLeafID = splitRoot.allLeaves.first?.id
    }
}
