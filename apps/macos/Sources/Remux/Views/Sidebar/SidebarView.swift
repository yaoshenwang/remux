import SwiftUI
import RemuxKit

/// Workspace sidebar showing sessions, tabs, and connection status.
/// Design ref: cmux TabManager/Workspace sidebar pattern
struct SidebarView: View {
    @Environment(RemuxState.self) private var state

    var body: some View {
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

            // Tab list
            Section("Tabs") {
                ForEach(state.tabs, id: \.index) { tab in
                    Button {
                        if let pane = tab.panes.first {
                            state.switchTab(id: pane.id)
                        }
                    } label: {
                        HStack {
                            Image(systemName: "terminal")
                                .foregroundStyle(tab.active ? .primary : .secondary)
                            Text(tab.name)
                            Spacer()
                            if tab.hasBell {
                                Circle()
                                    .fill(.red)
                                    .frame(width: 6, height: 6)
                            }
                        }
                    }
                    .buttonStyle(.plain)
                    .padding(.vertical, 2)
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
        .navigationTitle(state.currentSession.isEmpty ? "Remux" : state.currentSession)
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
