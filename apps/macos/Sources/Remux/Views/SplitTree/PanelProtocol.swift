import Foundation

/// Protocol for panels displayed in split panes.
/// TerminalPanel is the primary conformer; BrowserPanel, MarkdownPanel, etc.
/// can be added later.
@MainActor
protocol PanelProtocol: Identifiable {
    var id: UUID { get }
    var title: String { get }
    var canClose: Bool { get }

    func focus()
    func blur()
}
