import AppKit
import SwiftUI
import RemuxKit

/// Main application delegate. Manages windows, tray, and global state.
/// Architecture ref: cmux AppDelegate.swift
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var mainWindow: NSWindow?
    private var additionalWindows: [NSWindow] = []
    private var statusItem: NSStatusItem?
    private var menuBarManager: MenuBarManager?
    private(set) var notificationManager: NotificationManager?

    @MainActor
    let state = RemuxState()

    func applicationDidFinishLaunching(_ notification: Notification) {
        setupMainWindow()
        setupStatusItem()
        menuBarManager = MenuBarManager(state: state)
        notificationManager = NotificationManager()
        setupGlobalShortcut()
        // Auto-connect after a brief delay to ensure UI is ready
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            Task { @MainActor in
                self.autoConnectIfConfigured()
            }
        }
    }

    /// Auto-connect if REMUX_URL and REMUX_TOKEN environment variables are set.
    @MainActor
    private func autoConnectIfConfigured() {
        guard let urlStr = ProcessInfo.processInfo.environment["REMUX_URL"],
              let token = ProcessInfo.processInfo.environment["REMUX_TOKEN"],
              let url = URL(string: urlStr) else {
            NSLog("[remux] No REMUX_URL/REMUX_TOKEN env vars, showing connection UI")
            return
        }
        NSLog("[remux] Auto-connecting to %@", urlStr)
        state.connect(url: url, credential: .token(token))
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false // Keep running in tray
    }

    // MARK: - Main Window

    private func setupMainWindow() {
        let contentView = MainContentView()
            .environment(state)

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 800),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.minSize = NSSize(width: 800, height: 500)
        window.title = "Remux"
        window.contentView = NSHostingView(rootView: contentView)
        window.center()
        window.setFrameAutosaveName("RemuxMainWindow")
        window.makeKeyAndOrderFront(nil)

        mainWindow = window
    }

    // MARK: - System Tray

    private func setupStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = statusItem?.button {
            button.image = NSImage(systemSymbolName: "terminal", accessibilityDescription: "Remux")
            button.action = #selector(toggleWindow)
            button.target = self
        }

        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: "Show/Hide Window", action: #selector(toggleWindow), keyEquivalent: ""))
        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "Quit", action: #selector(NSApplication.terminate), keyEquivalent: "q"))
        statusItem?.menu = menu
    }

    // MARK: - Global Shortcut (Cmd+Shift+R)

    private func setupGlobalShortcut() {
        NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { event in
            // Cmd+Shift+R
            if event.modifierFlags.contains([.command, .shift]),
               event.charactersIgnoringModifiers == "r" {
                DispatchQueue.main.async { @MainActor in
                    if let appDelegate = NSApp.delegate as? AppDelegate {
                        appDelegate.toggleWindow()
                    }
                }
            }
        }
    }

    /// Create a new window sharing the same RemuxState connection.
    func createNewWindow() {
        let contentView = MainContentView()
            .environment(state)

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 800),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.minSize = NSSize(width: 800, height: 500)
        window.title = "Remux"
        window.contentView = NSHostingView(rootView: contentView)
        window.center()
        window.makeKeyAndOrderFront(nil)
        additionalWindows.append(window)
    }

    @objc private func toggleWindow() {
        if let window = mainWindow {
            if window.isVisible {
                window.orderOut(nil)
            } else {
                window.makeKeyAndOrderFront(nil)
                NSApp.activate(ignoringOtherApps: true)
            }
        }
    }
}
