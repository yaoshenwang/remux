import AppKit
import RemuxKit

/// Finder integration: "Open in Remux" service and external editor launcher.
/// When invoked from Finder (or via Services menu), creates a new tab with
/// the selected folder's CWD.
///
/// Also provides quick-launch for popular external editors.
/// Adapted from iTerm2 / Warp Finder integration patterns.
@MainActor
final class FinderIntegration: NSObject {

    private weak var state: RemuxState?

    /// External editor definitions.
    struct ExternalEditor: Identifiable {
        let id: String
        let name: String
        let bundleID: String
        let icon: String  // SF Symbol

        /// Check if this editor is installed.
        var isInstalled: Bool {
            NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID) != nil
        }
    }

    /// Known external editors.
    static let editors: [ExternalEditor] = [
        ExternalEditor(id: "vscode", name: "VS Code", bundleID: "com.microsoft.VSCode", icon: "chevron.left.forwardslash.chevron.right"),
        ExternalEditor(id: "cursor", name: "Cursor", bundleID: "com.todesktop.230313mzl4w4u92", icon: "cursorarrow.rays"),
        ExternalEditor(id: "zed", name: "Zed", bundleID: "dev.zed.Zed", icon: "bolt.fill"),
        ExternalEditor(id: "xcode", name: "Xcode", bundleID: "com.apple.dt.Xcode", icon: "hammer.fill"),
        ExternalEditor(id: "sublime", name: "Sublime Text", bundleID: "com.sublimetext.4", icon: "text.alignleft"),
    ]

    init(state: RemuxState) {
        self.state = state
        super.init()
    }

    // MARK: - Open folder in Remux (create tab with CWD)

    /// Handle "Open in Remux" service invocation.
    /// Sends a new_tab request; the server will create a tab.
    /// CWD is set by the server based on the default shell profile,
    /// but we include the path hint in the request.
    func openFolderInRemux(_ folderPath: String) {
        guard let state else { return }

        // Send a create-tab request with the folder path as a hint.
        // The server can use this to set the initial CWD.
        state.sendJSON([
            "type": "new_tab",
            "cwd": folderPath,
        ])

        // Bring Remux to front
        NSApp.activate(ignoringOtherApps: true)
        NSApp.keyWindow?.makeKeyAndOrderFront(nil)

        NSLog("[remux] Open in Remux: %@", folderPath)
    }

    // MARK: - Open in external editor

    /// Open a file or directory in the specified external editor.
    static func openInExternalEditor(path: String, editor: ExternalEditor) {
        guard let appURL = NSWorkspace.shared.urlForApplication(withBundleIdentifier: editor.bundleID) else {
            NSLog("[remux] Editor not found: %@", editor.name)
            return
        }

        let fileURL = URL(fileURLWithPath: path)
        let config = NSWorkspace.OpenConfiguration()
        config.activates = true

        NSWorkspace.shared.open(
            [fileURL],
            withApplicationAt: appURL,
            configuration: config
        ) { _, error in
            if let error {
                NSLog("[remux] Failed to open in %@: %@", editor.name, error.localizedDescription)
            }
        }
    }

    /// Get list of installed editors (for building menu).
    static var installedEditors: [ExternalEditor] {
        editors.filter { $0.isInstalled }
    }

    // MARK: - NSServices provider

    /// Register as services provider. Call from AppDelegate.
    /// For full Finder integration, the app's Info.plist needs NSServices entries.
    func registerServices() {
        NSApp.servicesProvider = self
    }

    /// Handle the "Open in Remux" service invocation from Finder.
    @objc func openInRemux(_ pboard: NSPasteboard, userData: String, error: AutoreleasingUnsafeMutablePointer<NSString>) {
        guard let urls = pboard.readObjects(forClasses: [NSURL.self], options: [
            .urlReadingFileURLsOnly: true,
        ]) as? [URL] else { return }

        for url in urls {
            if url.hasDirectoryPath {
                openFolderInRemux(url.path)
            } else {
                // For files, open the parent directory
                openFolderInRemux(url.deletingLastPathComponent().path)
            }
        }
    }
}
