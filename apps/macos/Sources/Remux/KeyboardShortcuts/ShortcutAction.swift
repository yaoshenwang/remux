import Foundation

/// All bindable actions in the app.
/// Adapted from ghostty-org/ghostty key binding action catalog design.
enum ShortcutAction: String, CaseIterable, Codable, Sendable {
    // Terminal
    case find
    case clearTerminal

    // Tabs
    case newTab
    case closeTab
    case nextTab
    case prevTab

    // Splits
    case splitRight
    case splitDown
    case closePane
    case focusNextPane
    case focusPrevPane

    // Window
    case toggleSidebar
    case toggleInspect
    case toggleFullscreen

    // Navigation (directional pane focus)
    case focusLeft
    case focusRight
    case focusUp
    case focusDown

    /// Human-readable display name for settings UI.
    var displayName: String {
        switch self {
        case .find:             return "Find"
        case .clearTerminal:    return "Clear Terminal"
        case .newTab:           return "New Tab"
        case .closeTab:         return "Close Tab"
        case .nextTab:          return "Next Tab"
        case .prevTab:          return "Previous Tab"
        case .splitRight:       return "Split Right"
        case .splitDown:        return "Split Down"
        case .closePane:        return "Close Pane"
        case .focusNextPane:    return "Focus Next Pane"
        case .focusPrevPane:    return "Focus Previous Pane"
        case .toggleSidebar:    return "Toggle Sidebar"
        case .toggleInspect:    return "Toggle Inspect"
        case .toggleFullscreen: return "Toggle Fullscreen"
        case .focusLeft:        return "Focus Left"
        case .focusRight:       return "Focus Right"
        case .focusUp:          return "Focus Up"
        case .focusDown:        return "Focus Down"
        }
    }

    /// Category for grouping in the settings UI.
    var category: String {
        switch self {
        case .find, .clearTerminal:
            return "Terminal"
        case .newTab, .closeTab, .nextTab, .prevTab:
            return "Tabs"
        case .splitRight, .splitDown, .closePane, .focusNextPane, .focusPrevPane:
            return "Splits"
        case .toggleSidebar, .toggleInspect, .toggleFullscreen:
            return "Window"
        case .focusLeft, .focusRight, .focusUp, .focusDown:
            return "Navigation"
        }
    }

    /// Default keyboard shortcut for this action.
    var defaultShortcut: StoredShortcut {
        switch self {
        case .find:
            return StoredShortcut(key: "f", command: true)
        case .clearTerminal:
            return StoredShortcut(key: "k", command: true)
        case .newTab:
            return StoredShortcut(key: "t", command: true)
        case .closeTab:
            return StoredShortcut(key: "w", command: true)
        case .nextTab:
            return StoredShortcut(key: "}", command: true, shift: true)
        case .prevTab:
            return StoredShortcut(key: "{", command: true, shift: true)
        case .splitRight:
            return StoredShortcut(key: "d", command: true)
        case .splitDown:
            return StoredShortcut(key: "d", command: true, shift: true)
        case .closePane:
            return StoredShortcut(key: "w", command: true, shift: true)
        case .focusNextPane:
            return StoredShortcut(key: "]", command: true, option: true)
        case .focusPrevPane:
            return StoredShortcut(key: "[", command: true, option: true)
        case .toggleSidebar:
            return StoredShortcut(key: "s", command: true, control: true)
        case .toggleInspect:
            return StoredShortcut(key: "i", command: true)
        case .toggleFullscreen:
            return StoredShortcut(key: "f", command: true, control: true)
        case .focusLeft:
            return StoredShortcut(key: "left", command: true, option: true)
        case .focusRight:
            return StoredShortcut(key: "right", command: true, option: true)
        case .focusUp:
            return StoredShortcut(key: "up", command: true, option: true)
        case .focusDown:
            return StoredShortcut(key: "down", command: true, option: true)
        }
    }
}
