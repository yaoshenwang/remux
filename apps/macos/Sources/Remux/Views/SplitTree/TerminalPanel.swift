import Foundation

/// Terminal panel conforming to PanelProtocol.
/// Wraps the terminal state for a single pane in the split tree.
@MainActor
final class TerminalPanel: PanelProtocol {
    let id: UUID
    let tabIndex: Int
    private(set) var isFocused = false

    var title: String { "Terminal \(tabIndex)" }
    var canClose: Bool { true }

    init(id: UUID = UUID(), tabIndex: Int) {
        self.id = id
        self.tabIndex = tabIndex
    }

    func focus() {
        isFocused = true
    }

    func blur() {
        isFocused = false
    }
}
