import SwiftUI
import RemuxKit

/// Main content view: sidebar + tab bar + split terminal/inspect area.
/// Includes command palette overlay and copy mode support.
struct MainContentView: View {
    @Environment(RemuxState.self) private var state
    @State private var showInspect = false
    @State private var windowNumber: Int?

    // Split pane state
    @State private var splitRoot: SplitNode = .leaf(SplitNode.LeafData(tabIndex: 0))
    @State private var focusedLeafID: UUID?

    // Command palette
    @State private var showCommandPalette = false

    // Copy mode
    @State private var showCopyMode = false

    // Port scanner
    @State private var portScanner = PortScanner()

    // SSH detector
    @State private var sshDetector = SSHDetector()

    var body: some View {
        ZStack {
            NavigationSplitView {
                SidebarView(portScanner: portScanner)
            } detail: {
                if case .connected = state.connectionStatus {
                    VStack(spacing: 0) {
                        TabBarView()

                        ZStack {
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

                            // Copy mode overlay
                            CopyModeOverlay(
                                isActive: $showCopyMode,
                                onRequestContent: {
                                    // Return terminal lines from inspect snapshot
                                    if let snapshot = state.inspectSnapshot {
                                        return snapshot.items.map { $0.content }
                                    }
                                    return []
                                },
                                onCopy: { _ in
                                    // Text already copied to clipboard in the overlay
                                }
                            )
                        }
                    }
                    .toolbar {
                        ToolbarItemGroup(placement: .automatic) {
                            // SSH upload button
                            if sshDetector.hasActiveConnection {
                                Button(action: { handleSSHUpload() }) {
                                    Image(systemName: "square.and.arrow.up")
                                }
                                .help("Upload File via SCP")
                            }

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

            // Command palette overlay
            CommandPalette(
                isPresented: $showCommandPalette,
                commands: buildCommandList()
            )

            WindowObserver { window in
                windowNumber = window?.windowNumber
            }
            .frame(width: 0, height: 0)
        }
        .onAppear {
            // Set initial focused leaf
            if focusedLeafID == nil {
                focusedLeafID = splitRoot.allLeaves.first?.id
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .remuxWindowCommand)) { notification in
            guard let command = WindowCommand(notification: notification),
                  command.matches(windowNumber: windowNumber) else {
                return
            }
            handleWindowCommand(command.action)
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
    func splitPane(leafID: UUID? = nil, orientation: SplitNode.Orientation, panelType: PanelType = .terminal) {
        let targetID = leafID ?? focusedLeafID ?? splitRoot.allLeaves.first?.id
        guard let targetID else { return }

        let newTabIndex = state.activeTabIndex
        splitRoot = splitRoot.split(
            leafID: targetID,
            orientation: orientation,
            newTabIndex: newTabIndex,
            panelType: panelType
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

    /// Add a browser pane to the split tree.
    func addBrowserPane() {
        splitPane(orientation: .horizontal, panelType: .browser)
    }

    /// Add a markdown pane to the split tree.
    func addMarkdownPane() {
        splitPane(orientation: .horizontal, panelType: .markdown)
    }

    /// Toggle command palette visibility.
    func toggleCommandPalette() {
        showCommandPalette.toggle()
    }

    /// Toggle copy mode.
    func toggleCopyMode() {
        // Request inspect content first so copy mode has data
        if !showCopyMode {
            state.requestInspect(tabIndex: state.activeTabIndex)
        }
        showCopyMode.toggle()
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

    // MARK: - Command palette commands

    private func buildCommandList() -> [PaletteCommand] {
        var commands: [PaletteCommand] = []

        // Commands from ShortcutAction
        for action in ShortcutAction.allCases {
            let shortcut = StoredShortcut.shortcut(for: action)
            commands.append(PaletteCommand(
                id: action.rawValue,
                name: action.displayName,
                shortcut: shortcut.displayString,
                category: action.category,
                action: { [self] in
                    executeShortcutAction(action)
                }
            ))
        }

        // Additional commands
        commands.append(PaletteCommand(
            id: "newBrowserPane",
            name: "New Browser Pane",
            shortcut: "\u{2318}\u{21E7}B",
            category: "Panels",
            action: { [self] in addBrowserPane() }
        ))

        commands.append(PaletteCommand(
            id: "newMarkdownPane",
            name: "New Markdown Pane",
            shortcut: "\u{2318}\u{21E7}M",
            category: "Panels",
            action: { [self] in addMarkdownPane() }
        ))

        commands.append(PaletteCommand(
            id: "copyMode",
            name: "Copy Mode",
            shortcut: "\u{2318}\u{21E7}C",
            category: "Terminal",
            action: { [self] in toggleCopyMode() }
        ))

        commands.append(PaletteCommand(
            id: "commandPalette",
            name: "Command Palette",
            shortcut: "\u{2318}\u{21E7}P",
            category: "Window",
            action: { /* Already open */ }
        ))

        return commands
    }

    private func executeShortcutAction(_ action: ShortcutAction) {
        switch action {
        case .find: break // Handled by terminal view
        case .clearTerminal: break
        case .newTab: state.createTab()
        case .closeTab:
            if let tab = state.tabs.first(where: { $0.active }),
               let pane = tab.panes.first {
                state.closeTab(id: pane.id)
            }
        case .nextTab:
            let tabs = state.tabs
            let idx = state.activeTabIndex
            if let nextTab = tabs.first(where: { $0.index > idx }) ?? tabs.first,
               let pane = nextTab.panes.first {
                state.switchTab(id: pane.id)
            }
        case .prevTab:
            let tabs = state.tabs
            let idx = state.activeTabIndex
            if let prevTab = tabs.last(where: { $0.index < idx }) ?? tabs.last,
               let pane = prevTab.panes.first {
                state.switchTab(id: pane.id)
            }
        case .splitRight: splitPane(orientation: .horizontal)
        case .splitDown: splitPane(orientation: .vertical)
        case .closePane: closePane()
        case .focusNextPane: focusNextPane()
        case .focusPrevPane: focusPreviousPane()
        case .toggleSidebar: break // Handled by NSSplitViewController
        case .toggleInspect: showInspect.toggle()
        case .toggleFullscreen:
            NSApp.keyWindow?.toggleFullScreen(nil)
        case .focusLeft, .focusRight, .focusUp, .focusDown:
            break // Directional focus — would need spatial awareness
        }
    }

    private func handleWindowCommand(_ action: WindowCommandAction) {
        switch action {
        case .splitRight:
            splitPane(orientation: .horizontal)
        case .splitDown:
            splitPane(orientation: .vertical)
        case .closePane:
            closePane()
        case .focusNextPane:
            focusNextPane()
        case .focusPreviousPane:
            focusPreviousPane()
        case .newBrowserPane:
            addBrowserPane()
        case .newMarkdownPane:
            addMarkdownPane()
        case .commandPalette:
            toggleCommandPalette()
        case .copyMode:
            toggleCopyMode()
        case .findInTerminal:
            guard let windowNumber,
                  let leafID = activeTerminalLeafID else {
                return
            }
            TerminalCommand(
                action: .showSearch,
                targetWindowNumber: windowNumber,
                leafID: leafID
            ).post()
        }
    }

    private var activeTerminalLeafID: UUID? {
        if let focusedLeafID,
           let leaf = splitRoot.findLeaf(id: focusedLeafID),
           leaf.panelType == .terminal {
            return focusedLeafID
        }

        return splitRoot.allLeaves.first(where: { $0.panelType == .terminal })?.id
    }

    // MARK: - SSH upload

    private func handleSSHUpload() {
        guard let url = sshDetector.pickFileForUpload(),
              let cmd = sshDetector.buildUploadCommand(localPath: url.path) else {
            return
        }
        state.sendTerminalInput(cmd + "\n")
    }
}
