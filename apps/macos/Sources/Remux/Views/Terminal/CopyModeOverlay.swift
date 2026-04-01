import SwiftUI
import AppKit

/// Vi-like copy mode overlay for terminal text selection.
/// Toggle with Cmd+Shift+C. Shows "COPY MODE" indicator.
/// Arrow keys move cursor, v enters visual select, y copies, Escape exits.
///
/// Works by reading current terminal text from inspect API and
/// rendering a selection overlay.
///
/// Adapted from tmux copy-mode and Zellij scroll/search mode UX patterns.
struct CopyModeOverlay: View {
    @Binding var isActive: Bool
    @State private var cursorRow: Int = 0
    @State private var cursorCol: Int = 0
    @State private var selectionStart: CopyModePosition?
    @State private var isVisualMode: Bool = false
    @State private var terminalLines: [String] = []
    @State private var statusMessage: String = ""

    /// Callback to request terminal text content.
    var onRequestContent: (() -> [String])?
    /// Callback when text is copied.
    var onCopy: ((String) -> Void)?

    struct CopyModePosition: Equatable {
        var row: Int
        var col: Int
    }

    var body: some View {
        if isActive {
            ZStack {
                // Semi-transparent overlay
                Color.black.opacity(0.05)
                    .allowsHitTesting(true)

                VStack {
                    // Mode indicator
                    HStack {
                        Spacer()

                        HStack(spacing: 6) {
                            Image(systemName: "doc.on.doc")
                                .font(.system(size: 10))
                            Text(isVisualMode ? "VISUAL" : "COPY MODE")
                                .font(.system(size: 11, weight: .semibold, design: .monospaced))
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 4)
                        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 6))
                        .overlay(
                            RoundedRectangle(cornerRadius: 6)
                                .stroke(Color.yellow.opacity(0.5), lineWidth: 1)
                        )
                        .padding(.trailing, 12)
                        .padding(.top, 8)
                    }

                    Spacer()

                    // Status bar
                    HStack {
                        if !statusMessage.isEmpty {
                            Text(statusMessage)
                                .font(.system(size: 11, design: .monospaced))
                                .foregroundStyle(.secondary)
                        }

                        Spacer()

                        Text("Ln \(cursorRow + 1), Col \(cursorCol + 1)")
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(.secondary)

                        Text("| h/j/k/l: move | v: visual | y: yank | Esc: exit")
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundStyle(.tertiary)
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 4)
                    .background(.ultraThinMaterial)
                }
            }
            .onAppear {
                loadContent()
            }
            .onKeyPress { keyPress in
                handleKeyPress(keyPress)
            }
        }
    }

    private func loadContent() {
        if let lines = onRequestContent?() {
            terminalLines = lines
            if !lines.isEmpty {
                cursorRow = max(0, lines.count - 1)
                cursorCol = 0
            }
        }
        statusMessage = ""
    }

    private func handleKeyPress(_ keyPress: KeyPress) -> KeyPress.Result {
        switch keyPress.characters {
        // Movement: vi keys
        case "h":
            moveCursor(dRow: 0, dCol: -1)
            return .handled
        case "j":
            moveCursor(dRow: 1, dCol: 0)
            return .handled
        case "k":
            moveCursor(dRow: -1, dCol: 0)
            return .handled
        case "l":
            moveCursor(dRow: 0, dCol: 1)
            return .handled

        // Movement: word
        case "w":
            moveWordForward()
            return .handled
        case "b":
            moveWordBackward()
            return .handled

        // Line start/end
        case "0":
            cursorCol = 0
            return .handled
        case "$":
            if cursorRow < terminalLines.count {
                cursorCol = max(0, terminalLines[cursorRow].count - 1)
            }
            return .handled

        // Top/bottom
        case "g":
            cursorRow = 0
            cursorCol = 0
            return .handled
        case "G":
            cursorRow = max(0, terminalLines.count - 1)
            cursorCol = 0
            return .handled

        // Visual mode toggle
        case "v":
            toggleVisualMode()
            return .handled

        // Yank (copy)
        case "y":
            yankSelection()
            return .handled

        default:
            break
        }

        // Arrow keys
        switch keyPress.key {
        case .upArrow:
            moveCursor(dRow: -1, dCol: 0)
            return .handled
        case .downArrow:
            moveCursor(dRow: 1, dCol: 0)
            return .handled
        case .leftArrow:
            moveCursor(dRow: 0, dCol: -1)
            return .handled
        case .rightArrow:
            moveCursor(dRow: 0, dCol: 1)
            return .handled
        case .escape:
            if isVisualMode {
                isVisualMode = false
                selectionStart = nil
                statusMessage = ""
            } else {
                isActive = false
            }
            return .handled
        default:
            break
        }

        return .ignored
    }

    private func moveCursor(dRow: Int, dCol: Int) {
        let newRow = max(0, min(terminalLines.count - 1, cursorRow + dRow))
        let maxCol = max(0, (newRow < terminalLines.count ? terminalLines[newRow].count : 80) - 1)
        let newCol = max(0, min(maxCol, cursorCol + dCol))
        cursorRow = newRow
        cursorCol = newCol
    }

    private func moveWordForward() {
        guard cursorRow < terminalLines.count else { return }
        let line = terminalLines[cursorRow]
        let chars = Array(line)
        var col = cursorCol

        // Skip current word characters
        while col < chars.count && !chars[col].isWhitespace { col += 1 }
        // Skip whitespace
        while col < chars.count && chars[col].isWhitespace { col += 1 }

        if col >= chars.count && cursorRow < terminalLines.count - 1 {
            cursorRow += 1
            cursorCol = 0
        } else {
            cursorCol = min(col, max(0, chars.count - 1))
        }
    }

    private func moveWordBackward() {
        guard cursorRow < terminalLines.count else { return }
        let line = terminalLines[cursorRow]
        let chars = Array(line)
        var col = cursorCol

        if col <= 0 && cursorRow > 0 {
            cursorRow -= 1
            cursorCol = max(0, terminalLines[cursorRow].count - 1)
            return
        }

        // Skip whitespace backwards
        while col > 0 && chars[max(0, col - 1)].isWhitespace { col -= 1 }
        // Skip word characters backwards
        while col > 0 && !chars[max(0, col - 1)].isWhitespace { col -= 1 }

        cursorCol = max(0, col)
    }

    private func toggleVisualMode() {
        if isVisualMode {
            isVisualMode = false
            selectionStart = nil
            statusMessage = ""
        } else {
            isVisualMode = true
            selectionStart = CopyModePosition(row: cursorRow, col: cursorCol)
            statusMessage = "VISUAL: move to select, y to yank"
        }
    }

    private func yankSelection() {
        let text: String
        if isVisualMode, let start = selectionStart {
            text = extractSelection(from: start, to: CopyModePosition(row: cursorRow, col: cursorCol))
        } else {
            // Yank current line
            if cursorRow < terminalLines.count {
                text = terminalLines[cursorRow]
            } else {
                text = ""
            }
        }

        guard !text.isEmpty else {
            statusMessage = "Nothing to yank"
            return
        }

        // Copy to clipboard
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)

        statusMessage = "Yanked \(text.count) chars"
        onCopy?(text)

        // Exit copy mode after yank
        isVisualMode = false
        selectionStart = nil

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
            self.isActive = false
        }
    }

    private func extractSelection(from start: CopyModePosition, to end: CopyModePosition) -> String {
        let (s, e) = start.row < end.row || (start.row == end.row && start.col <= end.col)
            ? (start, end) : (end, start)

        guard s.row < terminalLines.count else { return "" }

        if s.row == e.row {
            let line = terminalLines[s.row]
            let chars = Array(line)
            let startIdx = min(s.col, chars.count)
            let endIdx = min(e.col + 1, chars.count)
            return String(chars[startIdx..<endIdx])
        }

        var result: [String] = []

        // First line (from start col)
        let firstLine = terminalLines[s.row]
        let firstChars = Array(firstLine)
        let startIdx = min(s.col, firstChars.count)
        result.append(String(firstChars[startIdx...]))

        // Middle lines (full)
        for row in (s.row + 1)..<e.row {
            if row < terminalLines.count {
                result.append(terminalLines[row])
            }
        }

        // Last line (up to end col)
        if e.row < terminalLines.count {
            let lastLine = terminalLines[e.row]
            let lastChars = Array(lastLine)
            let endIdx = min(e.col + 1, lastChars.count)
            result.append(String(lastChars[..<endIdx]))
        }

        return result.joined(separator: "\n")
    }
}
