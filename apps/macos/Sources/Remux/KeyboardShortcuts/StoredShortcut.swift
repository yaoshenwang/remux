import AppKit

/// Persisted representation of a keyboard shortcut.
/// Adapted from ghostty-org/ghostty KeyEquivalent binding storage.
struct StoredShortcut: Codable, Equatable, Hashable, Sendable {
    var key: String           // e.g. "d", "left", "\r"
    var command: Bool
    var shift: Bool
    var option: Bool
    var control: Bool

    init(
        key: String,
        command: Bool = false,
        shift: Bool = false,
        option: Bool = false,
        control: Bool = false
    ) {
        self.key = key
        self.command = command
        self.shift = shift
        self.option = option
        self.control = control
    }

    /// Human-readable display string like "⌘D" or "⌃⌘F".
    var displayString: String {
        var parts: [String] = []
        if control { parts.append("⌃") }
        if option  { parts.append("⌥") }
        if shift   { parts.append("⇧") }
        if command { parts.append("⌘") }
        parts.append(keyDisplayName)
        return parts.joined()
    }

    /// Display name for the key character.
    private var keyDisplayName: String {
        switch key.lowercased() {
        case "left":   return "←"
        case "right":  return "→"
        case "up":     return "↑"
        case "down":   return "↓"
        case "\r", "return", "enter": return "↩"
        case "\t", "tab":   return "⇥"
        case " ", "space":  return "Space"
        case "\u{1b}", "escape": return "⎋"
        case "\u{7f}", "delete": return "⌫"
        case "[":  return "["
        case "]":  return "]"
        case "{":  return "{"
        case "}":  return "}"
        default:
            return key.uppercased()
        }
    }

    // MARK: - NSEvent conversion

    /// Create a StoredShortcut from an NSEvent (for recording shortcuts).
    @MainActor
    static func from(event: NSEvent) -> StoredShortcut? {
        guard event.type == .keyDown else { return nil }

        let mods = event.modifierFlags.intersection(.deviceIndependentFlagsMask)

        // Require at least one modifier key (prevent bare letters from being shortcuts)
        let hasModifier = mods.contains(.command) || mods.contains(.control) ||
                          mods.contains(.option)
        guard hasModifier else { return nil }

        let keyStr: String
        switch Int(event.keyCode) {
        case 123: keyStr = "left"
        case 124: keyStr = "right"
        case 125: keyStr = "down"
        case 126: keyStr = "up"
        case 36:  keyStr = "return"
        case 48:  keyStr = "tab"
        case 53:  keyStr = "escape"
        case 51:  keyStr = "delete"
        case 49:  keyStr = "space"
        default:
            if let chars = event.charactersIgnoringModifiers, !chars.isEmpty {
                keyStr = chars.lowercased()
            } else {
                return nil
            }
        }

        return StoredShortcut(
            key: keyStr,
            command: mods.contains(.command),
            shift: mods.contains(.shift),
            option: mods.contains(.option),
            control: mods.contains(.control)
        )
    }

    /// Check if an NSEvent matches this shortcut.
    @MainActor
    func matches(event: NSEvent) -> Bool {
        guard let recorded = StoredShortcut.from(event: event) else { return false }
        return self == recorded
    }

    // MARK: - Persistence via UserDefaults

    private static let defaultsKeyPrefix = "shortcut_"

    /// Get the current shortcut for an action (user-customized or default).
    static func shortcut(for action: ShortcutAction) -> StoredShortcut {
        let key = defaultsKeyPrefix + action.rawValue
        if let data = UserDefaults.standard.data(forKey: key),
           let stored = try? JSONDecoder().decode(StoredShortcut.self, from: data) {
            return stored
        }
        return action.defaultShortcut
    }

    /// Save a custom shortcut for an action.
    static func setShortcut(_ shortcut: StoredShortcut, for action: ShortcutAction) {
        let key = defaultsKeyPrefix + action.rawValue
        if let data = try? JSONEncoder().encode(shortcut) {
            UserDefaults.standard.set(data, forKey: key)
        }
    }

    /// Reset a shortcut to its default.
    static func resetShortcut(for action: ShortcutAction) {
        let key = defaultsKeyPrefix + action.rawValue
        UserDefaults.standard.removeObject(forKey: key)
    }

    /// Reset all shortcuts to defaults.
    static func resetAll() {
        for action in ShortcutAction.allCases {
            resetShortcut(for: action)
        }
    }

    /// Detect conflicts: returns any other actions that share the same shortcut.
    static func conflicts(for action: ShortcutAction) -> [ShortcutAction] {
        let current = shortcut(for: action)
        return ShortcutAction.allCases.filter { other in
            other != action && shortcut(for: other) == current
        }
    }
}
