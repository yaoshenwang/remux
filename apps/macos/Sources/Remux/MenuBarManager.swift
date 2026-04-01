import AppKit
import RemuxKit

/// Manages the native macOS menu bar.
@MainActor
final class MenuBarManager {
    private weak var state: RemuxState?

    /// Callback for split operations, wired from AppDelegate.
    var onSplitRight: (() -> Void)?
    var onSplitDown: (() -> Void)?
    var onClosePane: (() -> Void)?
    var onFocusNextPane: (() -> Void)?
    var onFocusPreviousPane: (() -> Void)?

    /// Callbacks for new features.
    var onNewBrowserPane: (() -> Void)?
    var onNewMarkdownPane: (() -> Void)?
    var onCommandPalette: (() -> Void)?
    var onCopyMode: (() -> Void)?
    var onDetachPane: (() -> Void)?

    init(state: RemuxState) {
        self.state = state
        setupMenuBar()
    }

    private func setupMenuBar() {
        let mainMenu = NSMenu()

        // App menu
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Remux", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Settings...", action: #selector(showSettings), keyEquivalent: ",")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Remux", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = appMenu.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Remux", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let appMenuItem = NSMenuItem()
        appMenuItem.submenu = appMenu
        mainMenu.addItem(appMenuItem)

        // File menu
        let fileMenu = NSMenu(title: "File")
        let newTab = fileMenu.addItem(withTitle: "New Tab", action: #selector(newTab(_:)), keyEquivalent: "t")
        newTab.target = self
        let closeTab = fileMenu.addItem(withTitle: "Close Tab", action: #selector(closeCurrentTab(_:)), keyEquivalent: "w")
        closeTab.target = self
        fileMenu.addItem(.separator())
        let newWindow = fileMenu.addItem(withTitle: "New Window", action: #selector(newWindow(_:)), keyEquivalent: "n")
        newWindow.target = self
        fileMenu.addItem(.separator())
        let newSession = fileMenu.addItem(withTitle: "New Session", action: #selector(newSession(_:)), keyEquivalent: "n")
        newSession.keyEquivalentModifierMask = [.command, .shift]
        newSession.target = self

        fileMenu.addItem(.separator())

        // Open in... submenu
        let openInMenu = NSMenu(title: "Open in...")
        for editor in FinderIntegration.installedEditors {
            let item = openInMenu.addItem(withTitle: editor.name, action: #selector(openInEditor(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = editor
            item.image = NSImage(systemSymbolName: editor.icon, accessibilityDescription: editor.name)
        }
        if openInMenu.items.isEmpty {
            openInMenu.addItem(withTitle: "No Editors Found", action: nil, keyEquivalent: "")
        }
        let openInMenuItem = NSMenuItem(title: "Open in...", action: nil, keyEquivalent: "")
        openInMenuItem.submenu = openInMenu
        fileMenu.addItem(openInMenuItem)

        let fileMenuItem = NSMenuItem()
        fileMenuItem.submenu = fileMenu
        mainMenu.addItem(fileMenuItem)

        // Edit menu
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editMenu.addItem(.separator())
        let findItem = editMenu.addItem(withTitle: "Find...", action: #selector(findInTerminal(_:)), keyEquivalent: "f")
        findItem.target = self
        editMenu.addItem(.separator())
        let copyModeItem = editMenu.addItem(withTitle: "Copy Mode", action: #selector(copyModeAction(_:)), keyEquivalent: "c")
        copyModeItem.keyEquivalentModifierMask = [.command, .shift]
        copyModeItem.target = self
        let editMenuItem = NSMenuItem()
        editMenuItem.submenu = editMenu
        mainMenu.addItem(editMenuItem)

        // View menu
        let viewMenu = NSMenu(title: "View")
        let toggleSidebar = viewMenu.addItem(withTitle: "Toggle Sidebar", action: #selector(toggleSidebar(_:)), keyEquivalent: "s")
        toggleSidebar.keyEquivalentModifierMask = [.command, .control]
        toggleSidebar.target = self

        viewMenu.addItem(.separator())

        // Command Palette
        let cmdPalette = viewMenu.addItem(withTitle: "Command Palette", action: #selector(commandPaletteAction(_:)), keyEquivalent: "p")
        cmdPalette.keyEquivalentModifierMask = [.command, .shift]
        cmdPalette.target = self

        viewMenu.addItem(.separator())

        // Split pane items
        let splitRight = viewMenu.addItem(withTitle: "Split Right", action: #selector(splitRightAction(_:)), keyEquivalent: "d")
        splitRight.target = self

        let splitDown = viewMenu.addItem(withTitle: "Split Down", action: #selector(splitDownAction(_:)), keyEquivalent: "d")
        splitDown.keyEquivalentModifierMask = [.command, .shift]
        splitDown.target = self

        viewMenu.addItem(.separator())

        // New panel types
        let browserPane = viewMenu.addItem(withTitle: "New Browser Pane", action: #selector(newBrowserPaneAction(_:)), keyEquivalent: "b")
        browserPane.keyEquivalentModifierMask = [.command, .shift]
        browserPane.target = self

        let markdownPane = viewMenu.addItem(withTitle: "New Markdown Pane", action: #selector(newMarkdownPaneAction(_:)), keyEquivalent: "m")
        markdownPane.keyEquivalentModifierMask = [.command, .shift]
        markdownPane.target = self

        viewMenu.addItem(.separator())

        let closePane = viewMenu.addItem(withTitle: "Close Pane", action: #selector(closePaneAction(_:)), keyEquivalent: "w")
        closePane.keyEquivalentModifierMask = [.command, .shift]
        closePane.target = self

        viewMenu.addItem(.separator())

        // Focus navigation
        let focusNext = viewMenu.addItem(withTitle: "Focus Next Pane", action: #selector(focusNextAction(_:)), keyEquivalent: "]")
        focusNext.keyEquivalentModifierMask = [.command, .option]
        focusNext.target = self

        let focusPrev = viewMenu.addItem(withTitle: "Focus Previous Pane", action: #selector(focusPrevAction(_:)), keyEquivalent: "[")
        focusPrev.keyEquivalentModifierMask = [.command, .option]
        focusPrev.target = self

        let viewMenuItem = NSMenuItem()
        viewMenuItem.submenu = viewMenu
        mainMenu.addItem(viewMenuItem)

        // Window menu
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        windowMenu.addItem(.separator())

        let detachPane = windowMenu.addItem(withTitle: "Detach Pane to Window", action: #selector(detachPaneAction(_:)), keyEquivalent: "\r")
        detachPane.keyEquivalentModifierMask = [.command, .shift]
        detachPane.target = self

        windowMenu.addItem(.separator())
        windowMenu.addItem(withTitle: "Bring All to Front", action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: "")
        let windowMenuItem = NSMenuItem()
        windowMenuItem.submenu = windowMenu
        mainMenu.addItem(windowMenuItem)
        NSApp.windowsMenu = windowMenu

        // Help menu
        let helpMenu = NSMenu(title: "Help")
        let helpMenuItem = NSMenuItem()
        helpMenuItem.submenu = helpMenu
        mainMenu.addItem(helpMenuItem)
        NSApp.helpMenu = helpMenu

        NSApp.mainMenu = mainMenu
    }

    @objc private func showSettings(_ sender: Any?) {
        NSApp.sendAction(Selector(("showSettingsWindow:")), to: nil, from: nil)
    }

    @objc private func newWindow(_ sender: Any?) {
        if let appDelegate = NSApp.delegate as? AppDelegate {
            appDelegate.createNewWindow()
        }
    }

    @objc private func newTab(_ sender: Any?) {
        state?.createTab()
    }

    @objc private func closeCurrentTab(_ sender: Any?) {
        guard let state, !state.tabs.isEmpty else { return }
        let activeTab = state.tabs.first { $0.index == state.activeTabIndex }
        if let pane = activeTab?.panes.first {
            state.closeTab(id: pane.id)
        }
    }

    @objc private func newSession(_ sender: Any?) {
        let name = "session-\(Int.random(in: 1000...9999))"
        state?.createSession(name: name)
    }

    @objc private func toggleSidebar(_ sender: Any?) {
        NSApp.keyWindow?.contentView?.window?.firstResponder?.tryToPerform(
            #selector(NSSplitViewController.toggleSidebar(_:)), with: nil
        )
    }

    @objc private func findInTerminal(_ sender: Any?) {
        // Search is triggered through the GhosttyNativeView's performKeyEquivalent
        // which intercepts Cmd+F. The menu item provides discoverability.
    }

    // MARK: - Split pane actions

    @objc private func splitRightAction(_ sender: Any?) {
        onSplitRight?()
    }

    @objc private func splitDownAction(_ sender: Any?) {
        onSplitDown?()
    }

    @objc private func closePaneAction(_ sender: Any?) {
        onClosePane?()
    }

    @objc private func focusNextAction(_ sender: Any?) {
        onFocusNextPane?()
    }

    @objc private func focusPrevAction(_ sender: Any?) {
        onFocusPreviousPane?()
    }

    // MARK: - New panel actions

    @objc private func newBrowserPaneAction(_ sender: Any?) {
        onNewBrowserPane?()
    }

    @objc private func newMarkdownPaneAction(_ sender: Any?) {
        onNewMarkdownPane?()
    }

    @objc private func commandPaletteAction(_ sender: Any?) {
        onCommandPalette?()
    }

    @objc private func copyModeAction(_ sender: Any?) {
        onCopyMode?()
    }

    @objc private func detachPaneAction(_ sender: Any?) {
        onDetachPane?()
    }

    @objc private func openInEditor(_ sender: Any?) {
        guard let item = sender as? NSMenuItem,
              let editor = item.representedObject as? FinderIntegration.ExternalEditor else { return }

        // Get CWD from the active tab
        guard let state,
              let tab = state.tabs.first(where: { $0.active }),
              let cwd = tab.panes.first?.cwd, !cwd.isEmpty else {
            return
        }

        FinderIntegration.openInExternalEditor(path: cwd, editor: editor)
    }
}
