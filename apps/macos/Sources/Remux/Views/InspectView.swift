import SwiftUI
import RemuxKit

/// Inspect panel showing readable terminal content.
/// Toggleable via Cmd+I or View menu.
struct InspectView: View {
    @Environment(RemuxState.self) private var state
    @State private var searchQuery = ""
    @State private var isAutoRefreshing = true

    private let refreshTimer = Timer.publish(every: 2, on: .main, in: .common).autoconnect()

    var body: some View {
        VStack(spacing: 0) {
            // Header with badges
            HStack {
                Text("Inspect")
                    .font(.headline)

                Spacer()

                if let snapshot = state.inspectSnapshot {
                    HStack(spacing: 6) {
                        Badge(text: snapshot.descriptor.source, color: .blue)
                        Badge(text: snapshot.descriptor.precision, color: precisionColor(snapshot.descriptor.precision))
                        Badge(text: snapshot.descriptor.staleness, color: stalenessColor(snapshot.descriptor.staleness))
                    }
                }

                Button(action: { requestInspect() }) {
                    Image(systemName: "arrow.clockwise")
                }
                .buttonStyle(.plain)
                .help("Refresh")
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(.bar)

            // Search bar
            HStack {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(.secondary)
                TextField("Search terminal content...", text: $searchQuery)
                    .textFieldStyle(.plain)
                    .onSubmit { requestInspect() }
                if !searchQuery.isEmpty {
                    Button(action: { searchQuery = ""; requestInspect() }) {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)

            Divider()

            // Content
            if let snapshot = state.inspectSnapshot {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(snapshot.items.enumerated()), id: \.offset) { _, item in
                            Text(item.content)
                                .font(.system(.body, design: .monospaced))
                                .foregroundStyle(item.type == "output" ? .primary : .secondary)
                                .textSelection(.enabled)
                                .padding(.horizontal, 12)
                                .padding(.vertical, 1)
                        }
                    }
                }
            } else {
                ContentUnavailableView(
                    "No Inspect Data",
                    systemImage: "doc.text",
                    description: Text("Connect to a server and switch to a tab to inspect terminal content.")
                )
            }
        }
        .onReceive(refreshTimer) { _ in
            if isAutoRefreshing {
                requestInspect()
            }
        }
        .onAppear { requestInspect() }
    }

    private func requestInspect() {
        state.requestInspect(
            tabIndex: state.activeTabIndex,
            query: searchQuery.isEmpty ? nil : searchQuery
        )
    }

    private func precisionColor(_ p: String) -> Color {
        switch p {
        case "precise": .green
        case "approximate": .yellow
        default: .gray
        }
    }

    private func stalenessColor(_ s: String) -> Color {
        switch s {
        case "fresh": .green
        case "stale": .orange
        default: .gray
        }
    }
}

struct Badge: View {
    let text: String
    let color: Color

    var body: some View {
        Text(text)
            .font(.system(size: 10))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(color.opacity(0.15))
            .foregroundStyle(color)
            .cornerRadius(4)
    }
}
