import SwiftUI
import RemuxKit

/// Workspace sidebar showing sessions, tabs, connection status, and update banner.
/// Supports git branch display, drag-to-reorder, and pin/unpin.
/// Design ref: cmux TabManager/Workspace sidebar pattern
struct SidebarView: View {
    @Environment(RemuxState.self) private var state

    /// Per-tab workspace colors. Key = tab index.
    @State private var tabColors: [Int: Color] = [:]

    /// Set of tab indices with unread activity (tabs that received data while not active).
    @State private var unreadTabs: Set<Int> = []

    /// Tab index currently being renamed (inline editing).
    @State private var renamingTabIndex: Int?

    /// Text field value for inline rename.
    @State private var renameText: String = ""

    /// Update checker instance (shared across views).
    @State private var updateChecker = UpdateChecker()

    /// Ordered tab indices for drag-to-reorder.
    @State private var tabOrder: [Int] = []

    /// Set of pinned tab indices.
    @State private var pinnedTabs: Set<Int> = []

    /// Git branch per tab (parsed from CWD's .git/HEAD).
    @State private var tabGitBranches: [Int: String] = [:]

    /// Port scanner (passed from parent).
    var portScanner: PortScanner?

    /// Preset colors for workspace color picker.
    private let presetColors: [Color] = [
        .red, .orange, .yellow, .green, .mint, .teal,
        .cyan, .blue, .indigo, .purple, .pink, .brown,
        .gray, Color(nsColor: .systemTeal), Color(nsColor: .systemIndigo),
        Color(nsColor: .controlAccentColor),
    ]

    /// Sorted tabs: pinned first, then ordered.
    private var sortedTabs: [WorkspaceTab] {
        let tabs = state.tabs
        let pinned = tabs.filter { pinnedTabs.contains($0.index) }
        let unpinned = tabs.filter { !pinnedTabs.contains($0.index) }
        return pinned + unpinned
    }

    var body: some View {
        VStack(spacing: 0) {
            List {
                // Connection status
                Section {
                    HStack {
                        Circle()
                            .fill(statusColor)
                            .frame(width: 8, height: 8)
                        Text(statusText)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                // Tab list with drag-to-reorder
                Section("Tabs") {
                    ForEach(sortedTabs, id: \.index) { tab in
                        SidebarTabRow(
                            tab: tab,
                            isActive: tab.active,
                            tabColor: tabColors[tab.index],
                            isUnread: unreadTabs.contains(tab.index),
                            isRenaming: renamingTabIndex == tab.index,
                            isPinned: pinnedTabs.contains(tab.index),
                            gitBranch: tabGitBranches[tab.index],
                            renameText: renamingTabIndex == tab.index ? $renameText : .constant(""),
                            presetColors: presetColors,
                            detectedPorts: portScanner?.ports ?? [],
                            onSelect: {
                                if let pane = tab.panes.first {
                                    state.switchTab(id: pane.id)
                                }
                                unreadTabs.remove(tab.index)
                            },
                            onRename: {
                                renamingTabIndex = tab.index
                                renameText = tab.name
                            },
                            onCommitRename: {
                                if let pane = tab.panes.first, !renameText.isEmpty {
                                    state.renameTab(id: pane.id, name: renameText)
                                }
                                renamingTabIndex = nil
                            },
                            onCancelRename: {
                                renamingTabIndex = nil
                            },
                            onColorSelect: { color in
                                tabColors[tab.index] = color
                            },
                            onTogglePin: {
                                if pinnedTabs.contains(tab.index) {
                                    pinnedTabs.remove(tab.index)
                                } else {
                                    pinnedTabs.insert(tab.index)
                                }
                            },
                            onOpenPort: { _ in }
                        )
                    }
                    .onMove { source, destination in
                        var ordered = sortedTabs.map(\.index)
                        ordered.move(fromOffsets: source, toOffset: destination)
                        tabOrder = ordered
                    }
                }

                // Actions
                Section {
                    Button {
                        state.createTab()
                    } label: {
                        Label("New Tab", systemImage: "plus")
                    }
                    .buttonStyle(.plain)
                }
            }
            .listStyle(.sidebar)

            // Footer: update banner
            if updateChecker.hasUpdate, let version = updateChecker.latestVersion {
                SidebarUpdateBanner(
                    version: version,
                    onDownload: { updateChecker.openReleasePage() },
                    onDismiss: { updateChecker.dismissCurrentUpdate() }
                )
            }
        }
        .navigationTitle(state.currentSession.isEmpty ? "Remux" : state.currentSession)
        .onAppear {
            updateChecker.start()
            refreshGitBranches()
        }
        .onChange(of: state.tabs) { _, _ in
            refreshGitBranches()
        }
    }

    // MARK: - Git branch detection

    /// Parse .git/HEAD from each tab's CWD to get the current branch.
    private func refreshGitBranches() {
        for tab in state.tabs {
            guard let cwd = tab.panes.first?.cwd, !cwd.isEmpty else { continue }
            let gitHead = (cwd as NSString).appendingPathComponent(".git/HEAD")
            if let content = try? String(contentsOfFile: gitHead, encoding: .utf8) {
                let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
                if trimmed.hasPrefix("ref: refs/heads/") {
                    let branch = String(trimmed.dropFirst("ref: refs/heads/".count))
                    tabGitBranches[tab.index] = branch
                } else {
                    // Detached HEAD — show short hash
                    tabGitBranches[tab.index] = String(trimmed.prefix(7))
                }
            }
        }
    }

    private var statusColor: Color {
        switch state.connectionStatus {
        case .connected: .green
        case .reconnecting: .yellow
        case .connecting, .authenticating: .orange
        case .disconnected: .red
        }
    }

    private var statusText: String {
        switch state.connectionStatus {
        case .connected: "Connected"
        case .reconnecting(let attempt): "Reconnecting (\(attempt))..."
        case .connecting: "Connecting..."
        case .authenticating: "Authenticating..."
        case .disconnected: "Disconnected"
        }
    }
}

// MARK: - Sidebar Tab Row

/// A single tab row in the sidebar with color indicator, unread dot, pin, git branch, and inline rename.
struct SidebarTabRow: View {
    let tab: WorkspaceTab
    let isActive: Bool
    let tabColor: Color?
    let isUnread: Bool
    let isRenaming: Bool
    let isPinned: Bool
    let gitBranch: String?
    @Binding var renameText: String
    let presetColors: [Color]
    let detectedPorts: [PortScanner.DetectedPort]
    var onSelect: () -> Void
    var onRename: () -> Void
    var onCommitRename: () -> Void
    var onCancelRename: () -> Void
    var onColorSelect: (Color) -> Void
    var onTogglePin: () -> Void
    var onOpenPort: (Int) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Button(action: onSelect) {
                HStack(spacing: 6) {
                    // Pin indicator
                    if isPinned {
                        Image(systemName: "pin.fill")
                            .font(.system(size: 8))
                            .foregroundStyle(.orange)
                    }

                    // Workspace color dot
                    if let color = tabColor {
                        Circle()
                            .fill(color)
                            .frame(width: 6, height: 6)
                    }

                    Image(systemName: "terminal")
                        .foregroundStyle(isActive ? .primary : .secondary)

                    // Tab name (editable or static)
                    if isRenaming {
                        TextField("Tab Name", text: $renameText, onCommit: onCommitRename)
                            .textFieldStyle(.roundedBorder)
                            .frame(maxWidth: 120)
                            .onExitCommand(perform: onCancelRename)
                    } else {
                        Text(tab.name)
                            .lineLimit(1)
                    }

                    Spacer()

                    // Unread activity indicator
                    if isUnread && !isActive {
                        UnreadDot()
                    }

                    // Bell indicator
                    if tab.hasBell {
                        Circle()
                            .fill(.red)
                            .frame(width: 6, height: 6)
                    }
                }
            }
            .buttonStyle(.plain)

            // Git branch display
            if let branch = gitBranch {
                HStack(spacing: 4) {
                    Image(systemName: "arrow.triangle.branch")
                        .font(.system(size: 9))
                        .foregroundStyle(.purple)
                    Text(branch)
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(.purple.opacity(0.8))
                        .lineLimit(1)
                }
                .padding(.leading, isPinned ? 20 : 14)
            }

            // Detected ports for this tab
            let tabPorts = detectedPorts
            if !tabPorts.isEmpty && isActive {
                ForEach(tabPorts) { port in
                    Button(action: { onOpenPort(port.port) }) {
                        HStack(spacing: 4) {
                            Image(systemName: "network")
                                .font(.system(size: 9))
                                .foregroundStyle(.blue)
                            Text(":\(port.port)")
                                .font(.system(size: 10, design: .monospaced))
                                .foregroundStyle(.blue)
                            Text(port.processName)
                                .font(.system(size: 9))
                                .foregroundStyle(.secondary)
                        }
                    }
                    .buttonStyle(.plain)
                    .padding(.leading, isPinned ? 20 : 14)
                }
            }
        }
        .padding(.vertical, 2)
        .contextMenu {
            // Pin/Unpin
            Button(isPinned ? "Unpin Tab" : "Pin Tab") { onTogglePin() }

            // Rename
            Button("Rename Tab") { onRename() }

            Divider()

            // Color picker submenu
            Menu("Set Color") {
                ForEach(Array(presetColors.enumerated()), id: \.offset) { idx, color in
                    Button {
                        onColorSelect(color)
                    } label: {
                        Label {
                            Text("Color \(idx + 1)")
                        } icon: {
                            Image(systemName: "circle.fill")
                                .foregroundStyle(color)
                        }
                    }
                }

                Divider()

                Button("Remove Color") {
                    onColorSelect(.clear)
                }
            }

            Divider()

            Button("Close Tab") {
                // Close handled via environment in the parent
            }
        }
        .onTapGesture(count: 2) {
            // Double-click to rename
            onRename()
        }
        .onTapGesture(count: 1) {
            onSelect()
        }
    }
}

// MARK: - Unread Activity Dot

/// Animated red dot indicating unread terminal activity.
struct UnreadDot: View {
    @State private var isPulsing = false

    var body: some View {
        Circle()
            .fill(.red)
            .frame(width: 8, height: 8)
            .scaleEffect(isPulsing ? 1.3 : 1.0)
            .opacity(isPulsing ? 0.7 : 1.0)
            .animation(
                .easeInOut(duration: 0.8).repeatForever(autoreverses: true),
                value: isPulsing
            )
            .onAppear { isPulsing = true }
    }
}

// MARK: - Update Banner

/// Banner shown in sidebar footer when a new version is available.
struct SidebarUpdateBanner: View {
    let version: String
    var onDownload: () -> Void
    var onDismiss: () -> Void

    var body: some View {
        VStack(spacing: 6) {
            Divider()

            HStack(spacing: 8) {
                Image(systemName: "arrow.down.circle.fill")
                    .foregroundStyle(.blue)
                    .font(.system(size: 14))

                VStack(alignment: .leading, spacing: 1) {
                    Text("Update Available")
                        .font(.caption.weight(.medium))
                    Text("v\(version)")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }

                Spacer()

                Button("Download") { onDownload() }
                    .controlSize(.small)
                    .buttonStyle(.borderedProminent)

                Button(action: onDismiss) {
                    Image(systemName: "xmark")
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
        }
        .background(.bar)
    }
}
