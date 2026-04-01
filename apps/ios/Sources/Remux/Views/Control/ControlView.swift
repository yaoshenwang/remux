import SwiftUI
import RemuxKit

/// Control tab: session/tab management with swipe actions.
struct ControlView: View {
    @Environment(RemuxState.self) private var state
    @State private var showNewSession = false

    var body: some View {
        NavigationStack {
            List {
                sessionSection
                tabsSection
                actionsSection
            }
            .navigationTitle("Control")
            .alert("New Session", isPresented: $showNewSession) {
                Button("Create") {
                    state.createSession(name: "session-\(Int.random(in: 1000...9999))")
                }
                Button("Cancel", role: .cancel) {}
            }
        }
    }

    private var sessionSection: some View {
        Section("Session") {
            HStack {
                Image(systemName: "server.rack")
                Text(state.currentSession)
                    .font(.headline)
                Spacer()
            }
        }
    }

    private var tabsSection: some View {
        Section("Tabs (\(state.tabs.count))") {
            ForEach(state.tabs, id: \.index) { tab in
                TabRow(tab: tab, isActive: tab.index == state.activeTabIndex)
                    .contentShape(Rectangle())
                    .onTapGesture {
                        if let pane = tab.panes.first {
                            state.switchTab(id: pane.id)
                        }
                    }
                    .swipeActions(edge: .trailing) {
                        Button(role: .destructive) {
                            if let pane = tab.panes.first {
                                state.closeTab(id: pane.id)
                            }
                        } label: {
                            Label("Close", systemImage: "xmark")
                        }
                    }
            }
        }
    }

    private var actionsSection: some View {
        Section {
            Button(action: { state.createTab() }) {
                Label("New Tab", systemImage: "plus")
            }
            Button(action: { showNewSession = true }) {
                Label("New Session", systemImage: "plus.rectangle.on.folder")
            }
        }
    }
}

struct TabRow: View {
    let tab: WorkspaceTab
    let isActive: Bool

    var body: some View {
        HStack {
            Image(systemName: isActive ? "terminal.fill" : "terminal")
                .foregroundStyle(isActive ? Color.accentColor : Color.secondary)
            VStack(alignment: .leading) {
                Text(tab.name)
                if let pane = tab.panes.first {
                    Text("\(pane.cols)×\(pane.rows)")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
            }
            Spacer()
            if isActive {
                Text("Active")
                    .font(.caption2)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(.tint.opacity(0.15))
                    .cornerRadius(4)
            }
            if tab.hasBell {
                Circle().fill(.red).frame(width: 6, height: 6)
            }
        }
    }
}
