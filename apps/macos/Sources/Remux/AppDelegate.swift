import AppKit
import SwiftUI
import RemuxKit

/// Main application delegate. Manages windows, tray, and global state.
/// Architecture ref: cmux AppDelegate.swift
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var mainWindow: NSWindow?
    private var additionalWindows: [NSWindow] = []
    private var detachedWindows: [UUID: NSWindow] = [:]
    private var statusItem: NSStatusItem?
    private var menuBarManager: MenuBarManager?
    private(set) var notificationManager: NotificationManager?
    private var socketController: SocketController?
    private var finderIntegration: FinderIntegration?

    @MainActor
    let state = RemuxState()

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Install crash reporter first
        CrashReporter.shared.install()

        // Load saved session (if any)
        let savedSession = SessionPersistence.shared.load()

        setupMainWindow(savedSession: savedSession)
        setupStatusItem()
        menuBarManager = MenuBarManager(state: state)
        notificationManager = NotificationManager()
        setupGlobalShortcut()

        // Start socket controller for CLI scripting
        socketController = SocketController(state: state)
        socketController?.start()

        // Setup Finder integration
        finderIntegration = FinderIntegration(state: state)
        finderIntegration?.registerServices()

        // Start autosave
        SessionPersistence.shared.startAutosave { [weak self] in
            guard let self else {
                return AppSession()
            }
            return self.buildCurrentSession()
        }

        // Auto-connect after a brief delay to ensure UI is ready
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            Task { @MainActor in
                self.autoConnectIfConfigured(savedSession: savedSession)
            }
        }

        // Check for crash reports from previous launch
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
            CrashReporter.shared.checkForPendingReports()
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        // Stop socket controller
        socketController?.stop()

        // Save session on quit
        Task { @MainActor in
            let session = buildCurrentSession()
            SessionPersistence.shared.save(session)
            SessionPersistence.shared.stopAutosave()
        }
    }

    /// Build the current session state for persistence.
    @MainActor
    private func buildCurrentSession() -> AppSession {
        var session = AppSession()

        // Server URL
        if case .connected = state.connectionStatus {
            session.serverURL = state.serverURL?.absoluteString
        }

        // Window frame
        if let frame = mainWindow?.frame {
            session.windowFrame = CodableRect(rect: frame)
        }

        // Split layout — for now, save a single leaf; the MainContentView
        // snapshot would need to be plumbed here for full persistence
        session.splitLayout = .leaf(tabIndex: state.activeTabIndex)
        session.sidebarCollapsed = false

        return session
    }

    /// Auto-connect if REMUX_URL and REMUX_TOKEN environment variables are set,
    /// or if a saved session has a server URL.
    @MainActor
    private func autoConnectIfConfigured(savedSession: AppSession?) {
        // Priority 1: Environment variables
        if let urlStr = ProcessInfo.processInfo.environment["REMUX_URL"],
           let token = ProcessInfo.processInfo.environment["REMUX_TOKEN"],
           let url = URL(string: urlStr) {
            NSLog("[remux] Auto-connecting to %@ (env vars)", urlStr)
            state.connect(url: url, credential: .token(token))
            return
        }

        // Priority 2: Saved session with server URL
        if let urlStr = savedSession?.serverURL,
           let url = URL(string: urlStr) {
            NSLog("[remux] Saved session has server URL: %@, showing connection UI", urlStr)
            // Don't auto-connect without credentials — just pre-fill the URL
        }

        NSLog("[remux] No REMUX_URL/REMUX_TOKEN env vars, showing connection UI")
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false // Keep running in tray
    }

    // MARK: - Main Window

    private func setupMainWindow(savedSession: AppSession? = nil) {
        let contentView = MainContentView()
            .environment(state)

        let defaultFrame = NSRect(x: 0, y: 0, width: 1280, height: 800)
        let windowFrame = savedSession?.windowCGRect ?? defaultFrame

        let window = NSWindow(
            contentRect: windowFrame,
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.minSize = NSSize(width: 800, height: 500)
        window.title = "Remux"
        window.contentView = NSHostingView(rootView: contentView)

        // Restore position or center
        if savedSession?.windowCGRect != nil {
            // Position is already set from windowFrame
        } else {
            window.center()
        }

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

    // MARK: - Window Portal (Detach Pane to Window)

    /// Detach a terminal panel to its own standalone window.
    /// The panel is displayed in a new NSWindow.
    func detachPaneToWindow() {
        let panelID = UUID()
        let contentView = TerminalContainerView()
            .environment(state)

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 800, height: 600),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.minSize = NSSize(width: 400, height: 300)
        window.title = "Remux (Detached)"
        window.contentView = NSHostingView(rootView: contentView)
        window.center()
        window.makeKeyAndOrderFront(nil)

        detachedWindows[panelID] = window

        // When the window closes, clean up
        NotificationCenter.default.addObserver(
            forName: NSWindow.willCloseNotification,
            object: window,
            queue: .main
        ) { [weak self] _ in
            self?.detachedWindows.removeValue(forKey: panelID)
        }
    }

    /// Close all detached windows and return their panels to the main window.
    func attachAllBack() {
        for (_, window) in detachedWindows {
            window.close()
        }
        detachedWindows.removeAll()
    }
}
