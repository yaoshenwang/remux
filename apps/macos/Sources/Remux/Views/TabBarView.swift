import SwiftUI
import RemuxKit

/// Horizontal tab bar showing tabs in the current session.
/// Supports click to switch, + button to create, close button on hover.
struct TabBarView: View {
    @Environment(RemuxState.self) private var state

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 0) {
                ForEach(state.tabs, id: \.index) { tab in
                    TabItemView(
                        tab: tab,
                        isActive: tab.index == state.activeTabIndex,
                        onSelect: {
                            if let pane = tab.panes.first {
                                state.switchTab(id: pane.id)
                            }
                        },
                        onClose: {
                            if let pane = tab.panes.first {
                                state.closeTab(id: pane.id)
                            }
                        }
                    )
                }

                // New tab button
                Button(action: { state.createTab() }) {
                    Image(systemName: "plus")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                        .frame(width: 28, height: 28)
                }
                .buttonStyle(.plain)
                .help("New Tab")

                Spacer()
            }
        }
        .frame(height: 32)
        .background(.bar)
    }
}

struct TabItemView: View {
    let tab: WorkspaceTab
    let isActive: Bool
    let onSelect: () -> Void
    let onClose: () -> Void

    @State private var isHovering = false

    var body: some View {
        HStack(spacing: 4) {
            if tab.hasBell {
                Circle()
                    .fill(.red)
                    .frame(width: 6, height: 6)
            }

            Text(tab.name)
                .font(.system(size: 12))
                .lineLimit(1)

            if isHovering {
                Button(action: onClose) {
                    Image(systemName: "xmark")
                        .font(.system(size: 8, weight: .bold))
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .frame(width: 14, height: 14)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(isActive ? Color.accentColor.opacity(0.15) : Color.clear)
        .cornerRadius(6)
        .overlay(
            RoundedRectangle(cornerRadius: 6)
                .stroke(isActive ? Color.accentColor.opacity(0.3) : Color.clear, lineWidth: 1)
        )
        .onHover { isHovering = $0 }
        .onTapGesture { onSelect() }
        .contextMenu {
            Button("Close Tab") { onClose() }
            Button("Rename Tab...") {
                // TODO: rename dialog
            }
        }
    }
}
