import SwiftUI
import RemuxKit

/// Recursive SwiftUI view that renders a SplitNode tree.
/// Leaf nodes render a TerminalContainerView; branch nodes render two
/// children with a draggable divider between them.
///
/// Architecture ref: ghostty-org/ghostty SplitView (recursive split pattern)
struct SplitView: View {
    let node: SplitNode
    @Binding var focusedLeafID: UUID?
    var onSplit: (UUID, SplitNode.Orientation) -> Void
    var onClose: (UUID) -> Void
    var onRatioChange: (UUID, CGFloat) -> Void

    var body: some View {
        switch node {
        case .leaf(let data):
            SplitLeafView(
                data: data,
                isFocused: focusedLeafID == data.id,
                onFocus: { focusedLeafID = data.id }
            )

        case .branch(let data):
            SplitBranchView(
                data: data,
                focusedLeafID: $focusedLeafID,
                onSplit: onSplit,
                onClose: onClose,
                onRatioChange: onRatioChange
            )
        }
    }
}

/// Renders a single leaf in the split tree — dispatches by panel type.
struct SplitLeafView: View {
    let data: SplitNode.LeafData
    let isFocused: Bool
    var onFocus: () -> Void

    /// Browser panels keyed by leaf ID (kept alive across re-renders).
    @State private var browserPanel: BrowserPanel?
    /// Markdown panels keyed by leaf ID.
    @State private var markdownPanel: MarkdownPanel?

    var body: some View {
        panelContent
            .overlay(alignment: .topLeading) {
                if isFocused {
                    RoundedRectangle(cornerRadius: 0)
                        .stroke(Color.accentColor.opacity(0.4), lineWidth: 2)
                        .allowsHitTesting(false)
                }
            }
            .contentShape(Rectangle())
            .onTapGesture {
                onFocus()
            }
    }

    @ViewBuilder
    private var panelContent: some View {
        switch data.panelType {
        case .terminal:
            TerminalContainerView(leafID: data.id)

        case .browser:
            let panel = getBrowserPanel()
            BrowserPanelView(panel: panel)

        case .markdown:
            let panel = getMarkdownPanel()
            MarkdownPanelView(panel: panel)
        }
    }

    private func getBrowserPanel() -> BrowserPanel {
        if let existing = browserPanel { return existing }
        let panel = BrowserPanel(id: data.id)
        DispatchQueue.main.async { browserPanel = panel }
        return panel
    }

    private func getMarkdownPanel() -> MarkdownPanel {
        if let existing = markdownPanel { return existing }
        let panel = MarkdownPanel(id: data.id)
        DispatchQueue.main.async { markdownPanel = panel }
        return panel
    }
}

/// Renders a branch node: two children separated by a draggable divider.
struct SplitBranchView: View {
    let data: SplitNode.BranchData
    @Binding var focusedLeafID: UUID?
    var onSplit: (UUID, SplitNode.Orientation) -> Void
    var onClose: (UUID) -> Void
    var onRatioChange: (UUID, CGFloat) -> Void

    @State private var dividerDragging = false

    var body: some View {
        GeometryReader { geometry in
            let isHorizontal = data.orientation == .horizontal
            let totalSize = isHorizontal ? geometry.size.width : geometry.size.height
            let dividerThickness: CGFloat = 4
            let availableSize = totalSize - dividerThickness
            let firstSize = availableSize * data.ratio
            let secondSize = availableSize * (1 - data.ratio)

            if isHorizontal {
                HStack(spacing: 0) {
                    // First child
                    SplitView(
                        node: data.first,
                        focusedLeafID: $focusedLeafID,
                        onSplit: onSplit,
                        onClose: onClose,
                        onRatioChange: onRatioChange
                    )
                    .frame(width: max(30, firstSize))

                    // Draggable divider
                    SplitDivider(isHorizontal: true, isDragging: $dividerDragging)
                        .gesture(
                            DragGesture()
                                .onChanged { value in
                                    dividerDragging = true
                                    let newRatio = (firstSize + value.translation.width) / availableSize
                                    onRatioChange(data.id, newRatio)
                                }
                                .onEnded { _ in
                                    dividerDragging = false
                                }
                        )

                    // Second child
                    SplitView(
                        node: data.second,
                        focusedLeafID: $focusedLeafID,
                        onSplit: onSplit,
                        onClose: onClose,
                        onRatioChange: onRatioChange
                    )
                    .frame(width: max(30, secondSize))
                }
            } else {
                VStack(spacing: 0) {
                    // First child
                    SplitView(
                        node: data.first,
                        focusedLeafID: $focusedLeafID,
                        onSplit: onSplit,
                        onClose: onClose,
                        onRatioChange: onRatioChange
                    )
                    .frame(height: max(30, firstSize))

                    // Draggable divider
                    SplitDivider(isHorizontal: false, isDragging: $dividerDragging)
                        .gesture(
                            DragGesture()
                                .onChanged { value in
                                    dividerDragging = true
                                    let newRatio = (firstSize + value.translation.height) / availableSize
                                    onRatioChange(data.id, newRatio)
                                }
                                .onEnded { _ in
                                    dividerDragging = false
                                }
                        )

                    // Second child
                    SplitView(
                        node: data.second,
                        focusedLeafID: $focusedLeafID,
                        onSplit: onSplit,
                        onClose: onClose,
                        onRatioChange: onRatioChange
                    )
                    .frame(height: max(30, secondSize))
                }
            }
        }
    }
}

/// The visual divider between split panes, with hover and drag states.
struct SplitDivider: View {
    let isHorizontal: Bool
    @Binding var isDragging: Bool
    @State private var isHovering = false

    var body: some View {
        Rectangle()
            .fill(fillColor)
            .frame(
                width: isHorizontal ? 4 : nil,
                height: isHorizontal ? nil : 4
            )
            .onHover { hovering in
                isHovering = hovering
                if hovering {
                    NSCursor.resizeLeftRight.push()
                } else {
                    NSCursor.pop()
                }
            }
            .onContinuousHover { phase in
                switch phase {
                case .active:
                    if isHorizontal {
                        NSCursor.resizeLeftRight.set()
                    } else {
                        NSCursor.resizeUpDown.set()
                    }
                case .ended:
                    NSCursor.arrow.set()
                }
            }
    }

    private var fillColor: Color {
        if isDragging {
            return Color.accentColor.opacity(0.6)
        } else if isHovering {
            return Color.accentColor.opacity(0.3)
        } else {
            return Color.primary.opacity(0.08)
        }
    }
}
