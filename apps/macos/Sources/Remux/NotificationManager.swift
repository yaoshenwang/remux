import AppKit
import UserNotifications

/// Manages terminal notifications with three-level escalation.
/// Ref: cmux TerminalNotificationStore.swift (design pattern, not code)
///
/// Level 1: Tab badge (red dot + count) — always
/// Level 2: Sidebar session highlight — always
/// Level 3: System notification — only when window not focused
@MainActor
final class NotificationManager: NSObject {

    struct TerminalNotification {
        let title: String
        let body: String
        let tabIndex: Int
        let sessionName: String
    }

    /// Notification counts per tab index
    private(set) var badgeCounts: [Int: Int] = [:]

    /// Rate limit: max 1 system notification per 30 seconds
    private var lastSystemNotification = Date.distantPast
    private let systemNotificationCooldown: TimeInterval = 30

    override init() {
        super.init()
        UNUserNotificationCenter.current().delegate = self
        requestPermission()
    }

    private func requestPermission() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
    }

    func handleNotification(_ notification: TerminalNotification) {
        // Level 1: Increment badge count
        badgeCounts[notification.tabIndex, default: 0] += 1

        // Level 3: System notification if window not focused
        let windowFocused = NSApp.isActive && NSApp.keyWindow != nil
        if !windowFocused {
            sendSystemNotification(notification)
        }
    }

    func clearBadge(forTab tabIndex: Int) {
        badgeCounts[tabIndex] = nil
    }

    func clearAllBadges() {
        badgeCounts.removeAll()
    }

    private func sendSystemNotification(_ notification: TerminalNotification) {
        let now = Date()
        guard now.timeIntervalSince(lastSystemNotification) > systemNotificationCooldown else { return }
        lastSystemNotification = now

        let content = UNMutableNotificationContent()
        content.title = notification.title
        content.body = notification.body
        content.sound = .default
        content.userInfo = [
            "tabIndex": notification.tabIndex,
            "sessionName": notification.sessionName,
        ]

        let request = UNNotificationRequest(
            identifier: UUID().uuidString,
            content: content,
            trigger: nil
        )
        UNUserNotificationCenter.current().add(request)
    }
}

extension NotificationManager: @preconcurrency UNUserNotificationCenterDelegate {
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        DispatchQueue.main.async {
            NSApp.activate(ignoringOtherApps: true)
            NSApp.keyWindow?.makeKeyAndOrderFront(nil)
        }
        completionHandler()
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        let options: UNNotificationPresentationOptions = NSApp.isActive ? [] : [.banner, .sound]
        completionHandler(options)
    }
}

// MARK: - OSC Notification Parser

/// Parses OSC 9/99/777 notification sequences from PTY data.
/// Ref: cmux OSC notification detection approach
struct OSCNotificationParser {
    /// Parse PTY data for notification sequences.
    /// Returns extracted notifications (if any).
    static func parse(_ data: Data) -> [String] {
        guard let text = String(data: data, encoding: .utf8) else { return [] }
        var notifications: [String] = []

        // OSC 9: iTerm2 notification — ESC ] 9 ; <message> BEL/ST
        let osc9Pattern = "\u{1b}]9;([^\u{07}\u{1b}]+)[\u{07}]"
        if let regex = try? NSRegularExpression(pattern: osc9Pattern) {
            let matches = regex.matches(in: text, range: NSRange(text.startIndex..., in: text))
            for match in matches {
                if let range = Range(match.range(at: 1), in: text) {
                    notifications.append(String(text[range]))
                }
            }
        }

        // OSC 777: rxvt-unicode notification — ESC ] 777 ; notify ; <title> ; <body> BEL
        let osc777Pattern = "\u{1b}]777;notify;([^;]*);([^\u{07}\u{1b}]*)[\u{07}]"
        if let regex = try? NSRegularExpression(pattern: osc777Pattern) {
            let matches = regex.matches(in: text, range: NSRange(text.startIndex..., in: text))
            for match in matches {
                if let range = Range(match.range(at: 2), in: text) {
                    notifications.append(String(text[range]))
                }
            }
        }

        return notifications
    }
}
