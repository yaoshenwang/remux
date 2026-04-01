import SwiftUI
import RemuxKit

/// Now tab: shows current status, active session, recent activity.
/// Design ref: hapi's Now first screen — focus on the 3 most important things.
struct NowView: View {
    @Environment(RemuxState.self) private var state

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 16) {
                    // Connection status card
                    ConnectionStatusCard()

                    // Active session card
                    if !state.currentSession.isEmpty {
                        SessionCard(
                            sessionName: state.currentSession,
                            tabCount: state.tabs.count,
                            activeTab: state.tabs.first { $0.index == state.activeTabIndex }
                        )
                    }

                    // Client role
                    HStack {
                        Image(systemName: state.clientRole == "active" ? "hand.raised.fill" : "eye.fill")
                        Text(state.clientRole == "active" ? "Active" : "Observer")
                            .font(.subheadline)
                        Spacer()
                        if state.clientRole == "observer" {
                            Button("Request Control") {
                                state.requestControl()
                            }
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                        }
                    }
                    .padding()
                    .background(.regularMaterial)
                    .cornerRadius(12)

                    // Quick actions
                    QuickActionsSection()
                }
                .padding()
            }
            .navigationTitle("Now")
            .refreshable {
                state.requestInspect(tabIndex: state.activeTabIndex)
            }
        }
    }
}

struct ConnectionStatusCard: View {
    @Environment(RemuxState.self) private var state

    var body: some View {
        HStack {
            Circle()
                .fill(statusColor)
                .frame(width: 10, height: 10)
            Text(statusText)
                .font(.subheadline.bold())
            Spacer()
            if let url = state.serverURL {
                Text(url.host ?? "")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding()
        .background(.regularMaterial)
        .cornerRadius(12)
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
        case .reconnecting(let n): "Reconnecting (\(n))..."
        case .connecting: "Connecting..."
        case .authenticating: "Authenticating..."
        case .disconnected: "Disconnected"
        }
    }
}

struct SessionCard: View {
    let sessionName: String
    let tabCount: Int
    let activeTab: WorkspaceTab?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Image(systemName: "terminal")
                Text(sessionName)
                    .font(.headline)
                Spacer()
                Text("\(tabCount) tab\(tabCount == 1 ? "" : "s")")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if let tab = activeTab {
                HStack {
                    Text("Active: \(tab.name)")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    if let cwd = tab.panes.first?.cwd {
                        Text(cwd)
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                    }
                }
            }
        }
        .padding()
        .background(.regularMaterial)
        .cornerRadius(12)
    }
}

struct QuickActionsSection: View {
    @Environment(RemuxState.self) private var state

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Quick Actions")
                .font(.caption)
                .foregroundStyle(.secondary)

            LazyVGrid(columns: [.init(.flexible()), .init(.flexible())], spacing: 8) {
                QuickActionButton(icon: "plus", title: "New Tab") {
                    state.createTab()
                }
                QuickActionButton(icon: "doc.text.magnifyingglass", title: "Inspect") {
                    // Switch to inspect tab — handled by parent TabView
                }
            }
        }
    }
}

struct QuickActionButton: View {
    let icon: String
    let title: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 6) {
                Image(systemName: icon)
                    .font(.title3)
                Text(title)
                    .font(.caption)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 12)
        }
        .buttonStyle(.bordered)
    }
}
