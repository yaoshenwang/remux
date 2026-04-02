import Foundation

enum WindowCommandAction: String, Sendable {
    case splitRight
    case splitDown
    case closePane
    case focusNextPane
    case focusPreviousPane
    case newBrowserPane
    case newMarkdownPane
    case commandPalette
    case copyMode
    case findInTerminal
}

struct WindowCommand: Equatable, Sendable {
    private static let actionKey = "action"
    private static let targetWindowNumberKey = "targetWindowNumber"

    let action: WindowCommandAction
    let targetWindowNumber: Int

    init(action: WindowCommandAction, targetWindowNumber: Int) {
        self.action = action
        self.targetWindowNumber = targetWindowNumber
    }

    init?(notification: Notification) {
        guard notification.name == .remuxWindowCommand,
              let rawAction = notification.userInfo?[Self.actionKey] as? String,
              let action = WindowCommandAction(rawValue: rawAction),
              let targetWindowNumber = notification.userInfo?[Self.targetWindowNumberKey] as? Int else {
            return nil
        }
        self.init(action: action, targetWindowNumber: targetWindowNumber)
    }

    func matches(windowNumber: Int?) -> Bool {
        guard let windowNumber else { return false }
        return targetWindowNumber == windowNumber
    }

    func post() {
        NotificationCenter.default.post(
            name: .remuxWindowCommand,
            object: nil,
            userInfo: [
                Self.actionKey: action.rawValue,
                Self.targetWindowNumberKey: targetWindowNumber,
            ]
        )
    }
}

enum TerminalCommandAction: String, Sendable {
    case showSearch
}

struct TerminalCommand: Equatable, Sendable {
    private static let actionKey = "action"
    private static let targetWindowNumberKey = "targetWindowNumber"
    private static let leafIDKey = "leafID"

    let action: TerminalCommandAction
    let targetWindowNumber: Int
    let leafID: UUID?

    init(action: TerminalCommandAction, targetWindowNumber: Int, leafID: UUID?) {
        self.action = action
        self.targetWindowNumber = targetWindowNumber
        self.leafID = leafID
    }

    init?(notification: Notification) {
        guard notification.name == .remuxTerminalCommand,
              let rawAction = notification.userInfo?[Self.actionKey] as? String,
              let action = TerminalCommandAction(rawValue: rawAction),
              let targetWindowNumber = notification.userInfo?[Self.targetWindowNumberKey] as? Int else {
            return nil
        }
        self.init(
            action: action,
            targetWindowNumber: targetWindowNumber,
            leafID: notification.userInfo?[Self.leafIDKey] as? UUID
        )
    }

    func matches(windowNumber: Int?, leafID: UUID?) -> Bool {
        guard let windowNumber, targetWindowNumber == windowNumber else {
            return false
        }
        return self.leafID == leafID
    }

    func post() {
        var userInfo: [String: Any] = [
            Self.actionKey: action.rawValue,
            Self.targetWindowNumberKey: targetWindowNumber,
        ]
        if let leafID {
            userInfo[Self.leafIDKey] = leafID
        }
        NotificationCenter.default.post(
            name: .remuxTerminalCommand,
            object: nil,
            userInfo: userInfo
        )
    }
}

extension Notification.Name {
    static let remuxWindowCommand = Notification.Name("remuxWindowCommand")
    static let remuxTerminalCommand = Notification.Name("remuxTerminalCommand")
}
