import SwiftUI

/// Settings view for customizing keyboard shortcuts.
/// Adapted from ghostty-org/ghostty macOS keybinding preferences pattern.
struct ShortcutSettingsView: View {
    @State private var shortcuts: [ShortcutAction: StoredShortcut] = loadAllShortcuts()
    @State private var recordingAction: ShortcutAction?
    @State private var conflicts: [ShortcutAction: [ShortcutAction]] = [:]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header
            HStack {
                Text("Keyboard Shortcuts")
                    .font(.headline)
                Spacer()
                Button("Reset All") {
                    resetAll()
                }
                .controlSize(.small)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)

            Divider()

            // Shortcut list grouped by category
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    let categories = orderedCategories()
                    ForEach(categories, id: \.self) { category in
                        let actions = ShortcutAction.allCases.filter { $0.category == category }
                        Section {
                            ForEach(actions, id: \.self) { action in
                                ShortcutRow(
                                    action: action,
                                    shortcut: shortcuts[action] ?? action.defaultShortcut,
                                    isRecording: recordingAction == action,
                                    hasConflict: !(conflicts[action]?.isEmpty ?? true),
                                    onStartRecording: {
                                        recordingAction = action
                                    },
                                    onRecorded: { newShortcut in
                                        applyShortcut(newShortcut, for: action)
                                    },
                                    onReset: {
                                        resetShortcut(for: action)
                                    },
                                    onCancelRecording: {
                                        recordingAction = nil
                                    }
                                )
                            }
                        } header: {
                            Text(category)
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(.secondary)
                                .padding(.horizontal, 16)
                                .padding(.top, 12)
                                .padding(.bottom, 4)
                        }
                    }
                }
                .padding(.bottom, 12)
            }
        }
        .frame(minWidth: 500, minHeight: 400)
        .onAppear { refreshConflicts() }
    }

    // MARK: - Actions

    private func applyShortcut(_ shortcut: StoredShortcut, for action: ShortcutAction) {
        StoredShortcut.setShortcut(shortcut, for: action)
        shortcuts[action] = shortcut
        recordingAction = nil
        refreshConflicts()
    }

    private func resetShortcut(for action: ShortcutAction) {
        StoredShortcut.resetShortcut(for: action)
        shortcuts[action] = action.defaultShortcut
        recordingAction = nil
        refreshConflicts()
    }

    private func resetAll() {
        StoredShortcut.resetAll()
        shortcuts = Self.loadAllShortcuts()
        recordingAction = nil
        refreshConflicts()
    }

    private func refreshConflicts() {
        var newConflicts: [ShortcutAction: [ShortcutAction]] = [:]
        for action in ShortcutAction.allCases {
            let found = StoredShortcut.conflicts(for: action)
            if !found.isEmpty {
                newConflicts[action] = found
            }
        }
        conflicts = newConflicts
    }

    private func orderedCategories() -> [String] {
        // Maintain a stable order
        ["Terminal", "Tabs", "Splits", "Window", "Navigation"]
    }

    private static func loadAllShortcuts() -> [ShortcutAction: StoredShortcut] {
        var map: [ShortcutAction: StoredShortcut] = [:]
        for action in ShortcutAction.allCases {
            map[action] = StoredShortcut.shortcut(for: action)
        }
        return map
    }
}

// MARK: - Shortcut Row

/// A single row in the shortcut list: action name + shortcut badge + record/reset controls.
struct ShortcutRow: View {
    let action: ShortcutAction
    let shortcut: StoredShortcut
    let isRecording: Bool
    let hasConflict: Bool
    var onStartRecording: () -> Void
    var onRecorded: (StoredShortcut) -> Void
    var onReset: () -> Void
    var onCancelRecording: () -> Void

    @State private var isHovering = false

    var body: some View {
        HStack {
            Text(action.displayName)
                .frame(minWidth: 160, alignment: .leading)

            Spacer()

            if isRecording {
                ShortcutRecorderField(
                    onRecorded: onRecorded,
                    onCancel: onCancelRecording
                )
                .frame(width: 140)
            } else {
                // Shortcut display badge
                Text(shortcut.displayString)
                    .font(.system(size: 12, design: .monospaced))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(
                        RoundedRectangle(cornerRadius: 4)
                            .fill(hasConflict ? Color.red.opacity(0.15) : Color.primary.opacity(0.06))
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: 4)
                            .stroke(hasConflict ? Color.red.opacity(0.4) : Color.clear, lineWidth: 1)
                    )
                    .onTapGesture { onStartRecording() }
            }

            // Reset button (shown on hover or if customized)
            if isHovering && shortcut != action.defaultShortcut {
                Button(action: onReset) {
                    Image(systemName: "arrow.counterclockwise")
                        .font(.system(size: 10))
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .help("Reset to Default")
            }

            if hasConflict {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 10))
                    .foregroundStyle(.yellow)
                    .help("Shortcut conflict detected")
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 5)
        .background(isHovering ? Color.primary.opacity(0.03) : Color.clear)
        .onHover { isHovering = $0 }
    }
}

// MARK: - Shortcut Recorder

/// An inline field that captures the next key event as a new shortcut.
struct ShortcutRecorderField: NSViewRepresentable {
    var onRecorded: (StoredShortcut) -> Void
    var onCancel: () -> Void

    func makeNSView(context: Context) -> ShortcutRecorderNSView {
        let view = ShortcutRecorderNSView()
        view.onRecorded = onRecorded
        view.onCancel = onCancel
        // Become first responder after a brief delay to ensure the view is in the hierarchy
        DispatchQueue.main.async {
            view.window?.makeFirstResponder(view)
        }
        return view
    }

    func updateNSView(_ nsView: ShortcutRecorderNSView, context: Context) {
        nsView.onRecorded = onRecorded
        nsView.onCancel = onCancel
    }
}

/// NSView that captures a single key event for shortcut recording.
@MainActor
final class ShortcutRecorderNSView: NSView {
    var onRecorded: ((StoredShortcut) -> Void)?
    var onCancel: (() -> Void)?

    override var acceptsFirstResponder: Bool { true }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.cornerRadius = 4
        layer?.borderWidth = 2
        layer?.borderColor = NSColor.controlAccentColor.cgColor
    }

    required init?(coder: NSCoder) { fatalError() }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        let str = NSAttributedString(
            string: "Press shortcut...",
            attributes: [
                .foregroundColor: NSColor.secondaryLabelColor,
                .font: NSFont.systemFont(ofSize: 11),
            ]
        )
        let size = str.size()
        let point = NSPoint(
            x: (bounds.width - size.width) / 2,
            y: (bounds.height - size.height) / 2
        )
        str.draw(at: point)
    }

    override func keyDown(with event: NSEvent) {
        // Escape cancels recording
        if event.keyCode == 53 {
            onCancel?()
            return
        }

        if let shortcut = StoredShortcut.from(event: event) {
            onRecorded?(shortcut)
        }
        // If no valid shortcut (e.g. bare key press), ignore and keep recording
    }

    override func becomeFirstResponder() -> Bool {
        layer?.borderColor = NSColor.controlAccentColor.cgColor
        return true
    }

    override func resignFirstResponder() -> Bool {
        layer?.borderColor = NSColor.separatorColor.cgColor
        onCancel?()
        return true
    }
}
