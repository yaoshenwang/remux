import SwiftUI
import RemuxKit

/// Inspect tab: readable terminal content with badges, search, pagination.
struct InspectView: View {
    @Environment(RemuxState.self) private var state
    @State private var searchQuery = ""

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                // Tab selector
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(state.tabs, id: \.index) { tab in
                            Button {
                                state.requestInspect(tabIndex: tab.index)
                            } label: {
                                Text(tab.name)
                                    .font(.caption)
                                    .padding(.horizontal, 12)
                                    .padding(.vertical, 6)
                                    .background(tab.index == state.activeTabIndex ? Color.accentColor : Color.secondary.opacity(0.15))
                                    .foregroundStyle(tab.index == state.activeTabIndex ? .white : .primary)
                                    .cornerRadius(16)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.horizontal)
                    .padding(.vertical, 8)
                }

                // Descriptor badges
                if let snapshot = state.inspectSnapshot {
                    HStack(spacing: 6) {
                        Badge(text: snapshot.descriptor.source, color: .blue)
                        Badge(text: snapshot.descriptor.precision, color: snapshot.descriptor.precision == "precise" ? .green : .yellow)
                        Badge(text: snapshot.descriptor.staleness, color: snapshot.descriptor.staleness == "fresh" ? .green : .orange)
                        Spacer()
                        Text(snapshot.descriptor.capturedAt.prefix(19).replacingOccurrences(of: "T", with: " "))
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                    .padding(.horizontal)
                    .padding(.bottom, 4)
                }

                Divider()

                // Content
                if let snapshot = state.inspectSnapshot {
                    List {
                        ForEach(Array(snapshot.items.enumerated()), id: \.offset) { _, item in
                            Text(item.content)
                                .font(.system(.caption, design: .monospaced))
                                .foregroundStyle(item.type == "output" ? .primary : .secondary)
                                .listRowInsets(EdgeInsets(top: 1, leading: 12, bottom: 1, trailing: 12))
                        }
                    }
                    .listStyle(.plain)
                } else {
                    ContentUnavailableView(
                        "No Inspect Data",
                        systemImage: "doc.text",
                        description: Text("Pull to refresh or switch tabs above.")
                    )
                }
            }
            .navigationTitle("Inspect")
            .searchable(text: $searchQuery, prompt: "Search terminal content")
            .onSubmit(of: .search) {
                state.requestInspect(tabIndex: state.activeTabIndex, query: searchQuery.isEmpty ? nil : searchQuery)
            }
            .refreshable {
                state.requestInspect(tabIndex: state.activeTabIndex, query: searchQuery.isEmpty ? nil : searchQuery)
            }
            .onAppear {
                state.requestInspect(tabIndex: state.activeTabIndex)
            }
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
