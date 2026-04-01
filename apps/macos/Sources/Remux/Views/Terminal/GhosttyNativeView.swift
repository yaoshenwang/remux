import AppKit
import GhosttyKit

/// NSView subclass wrapping libghostty's native Metal terminal renderer.
/// Adapted for ghostty v1.3.1 API: uses `command` field to spawn a relay
/// process (`nc -U <socket>`) that bridges Unix socket <-> PTY stdio.
///
/// Data flow:
///   Remote PTY -> WebSocket -> TerminalRelay.writeToTerminal() -> socket -> nc stdout -> ghostty renders
///   User types -> ghostty -> nc stdin -> socket -> TerminalRelay.onDataFromClient -> WebSocket -> remote PTY
///
/// Architecture ref: Calyx, Kytos (libghostty-based terminal apps)
@MainActor
final class GhosttyNativeView: NSView {

    // MARK: - Callbacks

    var onResize: ((Int, Int) -> Void)?
    var onBell: (() -> Void)?
    var onTitle: ((String) -> Void)?

    // Search callbacks
    var onSearchStart: ((String?) -> Void)?
    var onSearchEnd: (() -> Void)?
    var onSearchTotal: ((Int) -> Void)?
    var onSearchSelected: ((Int) -> Void)?

    // MARK: - Ghostty state (nonisolated for deinit cleanup)

    nonisolated(unsafe) private var ghosttyApp: ghostty_app_t?
    nonisolated(unsafe) private var surface: ghostty_surface_t?

    /// The relay command spawned by ghostty as its "shell" process.
    private(set) var relayCommand: String?

    // MARK: - Init

    /// Create the view with a relay socket path. Ghostty will spawn `nc -U <socketPath>`.
    init(frame frameRect: NSRect, socketPath: String) {
        self.relayCommand = "nc -U \(socketPath)"
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.isOpaque = true
        layer?.backgroundColor = NSColor.black.cgColor
        initGhostty()
    }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.isOpaque = true
        layer?.backgroundColor = NSColor.black.cgColor
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) not supported")
    }

    deinit {
        if let surface { ghostty_surface_free(surface) }
        if let ghosttyApp { ghostty_app_free(ghosttyApp) }
    }

    // MARK: - Ghostty initialization

    private func initGhostty() {
        ghostty_init(0, nil)

        let config = ghostty_config_new()!
        ghostty_config_load_default_files(config)
        ghostty_config_finalize(config)

        // Runtime callbacks
        var rtConfig = ghostty_runtime_config_s()
        rtConfig.userdata = Unmanaged.passUnretained(self).toOpaque()
        rtConfig.supports_selection_clipboard = true

        rtConfig.wakeup_cb = { ud in
            guard let ud else { return }
            let view = Unmanaged<GhosttyNativeView>.fromOpaque(ud).takeUnretainedValue()
            DispatchQueue.main.async {
                view.needsDisplay = true
            }
        }

        rtConfig.action_cb = { app, target, action in
            guard let app else { return false }
            guard let ud = ghostty_app_userdata(app) else { return false }
            let view = Unmanaged<GhosttyNativeView>.fromOpaque(ud).takeUnretainedValue()
            return GhosttyNativeView.handleAction(view: view, target: target, action: action)
        }

        rtConfig.read_clipboard_cb = { ud, clipboard, state in
            guard let ud else { return false }
            let view = Unmanaged<GhosttyNativeView>.fromOpaque(ud).takeUnretainedValue()
            guard let surface = view.surface else { return false }
            let pb = NSPasteboard.general
            if let str = pb.string(forType: .string) {
                str.withCString { ptr in
                    ghostty_surface_complete_clipboard_request(surface, ptr, state, true)
                }
                return true
            }
            return false
        }

        rtConfig.confirm_read_clipboard_cb = { ud, content, state, req in
            // Auto-confirm clipboard reads for simplicity
            guard let ud else { return }
            let view = Unmanaged<GhosttyNativeView>.fromOpaque(ud).takeUnretainedValue()
            guard let surface = view.surface, let content else { return }
            ghostty_surface_complete_clipboard_request(surface, content, state, true)
        }

        rtConfig.write_clipboard_cb = { _, clipboard, content, count, _ in
            guard let content, count > 0, let data = content.pointee.data else { return }
            let str = String(cString: data)
            let pb: NSPasteboard
            if clipboard == GHOSTTY_CLIPBOARD_SELECTION {
                // Selection clipboard: use a named pasteboard
                pb = NSPasteboard(name: .init("org.remux.selection"))
            } else {
                pb = NSPasteboard.general
            }
            pb.clearContents()
            pb.setString(str, forType: .string)
        }

        rtConfig.close_surface_cb = { _, _ in }

        ghosttyApp = ghostty_app_new(&rtConfig, config)
        ghostty_config_free(config)
        guard let ghosttyApp else { return }

        // Surface config — relay command as the "shell"
        var surfaceConfig = ghostty_surface_config_new()
        surfaceConfig.platform_tag = GHOSTTY_PLATFORM_MACOS
        surfaceConfig.platform = ghostty_platform_u(
            macos: ghostty_platform_macos_s(
                nsview: Unmanaged.passUnretained(self).toOpaque()
            )
        )
        surfaceConfig.userdata = Unmanaged.passUnretained(self).toOpaque()

        if let screen = NSScreen.main {
            surfaceConfig.scale_factor = screen.backingScaleFactor
        }

        // Set relay command: nc connects to the Unix socket and pipes stdio
        if let cmd = relayCommand {
            cmd.withCString { ptr in
                surfaceConfig.command = ptr
                surface = ghostty_surface_new(ghosttyApp, &surfaceConfig)
            }
        } else {
            surface = ghostty_surface_new(ghosttyApp, &surfaceConfig)
        }
    }

    // MARK: - Action handler (called from C callback context)

    /// Handle ghostty actions. This is a static method so the C function pointer
    /// (action_cb) can dispatch to it via Unmanaged userdata.
    nonisolated private static func handleAction(
        view: GhosttyNativeView,
        target: ghostty_target_s,
        action: ghostty_action_s
    ) -> Bool {
        // All UI work must happen on MainActor
        DispatchQueue.main.async { @MainActor in
            switch action.tag {
            case GHOSTTY_ACTION_RING_BELL:
                view.onBell?()

            case GHOSTTY_ACTION_SET_TITLE:
                if let titlePtr = action.action.set_title.title {
                    let title = String(cString: titlePtr)
                    view.onTitle?(title)
                }

            case GHOSTTY_ACTION_START_SEARCH:
                var needle: String? = nil
                if let needlePtr = action.action.start_search.needle {
                    needle = String(cString: needlePtr)
                }
                view.onSearchStart?(needle)

            case GHOSTTY_ACTION_END_SEARCH:
                view.onSearchEnd?()

            case GHOSTTY_ACTION_SEARCH_TOTAL:
                let total = Int(action.action.search_total.total)
                view.onSearchTotal?(total)

            case GHOSTTY_ACTION_SEARCH_SELECTED:
                let selected = Int(action.action.search_selected.selected)
                view.onSearchSelected?(selected)

            case GHOSTTY_ACTION_DESKTOP_NOTIFICATION:
                // Could forward to NotificationManager if desired
                break

            default:
                break
            }
        }
        return true
    }

    // MARK: - Search methods

    /// Navigate to the next search match.
    func searchForward() {
        guard let surface else { return }
        let action = "search_forward"
        _ = ghostty_surface_binding_action(surface, action, UInt(action.utf8.count))
    }

    /// Navigate to the previous search match.
    func searchBackward() {
        guard let surface else { return }
        let action = "search_backward"
        _ = ghostty_surface_binding_action(surface, action, UInt(action.utf8.count))
    }

    /// Send text input directly to the ghostty surface (used for paste).
    func sendText(_ text: String) {
        guard let surface else { return }
        ghostty_surface_text(surface, text, UInt(text.utf8.count))
    }

    // MARK: - View lifecycle

    override var acceptsFirstResponder: Bool { true }
    override var isFlipped: Bool { true }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        guard let surface else { return }
        if let screen = window?.screen {
            ghostty_surface_set_content_scale(surface, screen.backingScaleFactor, screen.backingScaleFactor)
        }
        ghostty_surface_set_focus(surface, window != nil)
    }

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        guard let surface, newSize.width > 0, newSize.height > 0 else { return }
        ghostty_surface_set_size(surface, UInt32(newSize.width), UInt32(newSize.height))
        let termSize = ghostty_surface_size(surface)
        onResize?(Int(termSize.columns), Int(termSize.rows))
    }

    override func draw(_ dirtyRect: NSRect) {
        surface.flatMap { ghostty_surface_draw($0) }
    }

    // MARK: - Keyboard input (ghostty handles forwarding to PTY -> nc stdin -> socket)

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        // Intercept Cmd+V for enhanced paste
        if event.modifierFlags.contains(.command),
           event.charactersIgnoringModifiers == "v" {
            handlePaste()
            return true
        }

        // Intercept Cmd+F for search
        if event.modifierFlags.contains(.command),
           event.charactersIgnoringModifiers == "f" {
            onSearchStart?(nil)
            return true
        }

        return super.performKeyEquivalent(with: event)
    }

    override func keyDown(with event: NSEvent) {
        guard let surface else { return }
        var key = ghostty_input_key_s()
        key.action = GHOSTTY_ACTION_PRESS
        key.keycode = UInt32(event.keyCode)
        key.composing = false
        if event.isARepeat { key.action = GHOSTTY_ACTION_REPEAT }
        _ = ghostty_surface_key(surface, key)
    }

    override func keyUp(with event: NSEvent) {
        guard let surface else { return }
        var key = ghostty_input_key_s()
        key.action = GHOSTTY_ACTION_RELEASE
        key.keycode = UInt32(event.keyCode)
        key.composing = false
        _ = ghostty_surface_key(surface, key)
    }

    func insertText(_ string: Any, replacementRange: NSRange) {
        guard let surface else { return }
        if let str = string as? String {
            ghostty_surface_text(surface, str, UInt(str.utf8.count))
        }
    }

    override func doCommand(by selector: Selector) {}

    // MARK: - Mouse input

    override func mouseDown(with event: NSEvent) {
        guard let surface else { return }
        window?.makeFirstResponder(self)
        ghostty_surface_mouse_button(surface, GHOSTTY_MOUSE_PRESS, GHOSTTY_MOUSE_LEFT, ghostty_input_mods_e(rawValue: 0))
    }

    override func mouseUp(with event: NSEvent) {
        guard let surface else { return }
        ghostty_surface_mouse_button(surface, GHOSTTY_MOUSE_RELEASE, GHOSTTY_MOUSE_LEFT, ghostty_input_mods_e(rawValue: 0))
    }

    override func mouseMoved(with event: NSEvent) {
        guard let surface else { return }
        let pt = convert(event.locationInWindow, from: nil)
        ghostty_surface_mouse_pos(surface, pt.x, pt.y, ghostty_input_mods_e(rawValue: 0))
    }

    override func mouseDragged(with event: NSEvent) {
        guard let surface else { return }
        let pt = convert(event.locationInWindow, from: nil)
        ghostty_surface_mouse_pos(surface, pt.x, pt.y, ghostty_input_mods_e(rawValue: 0))
    }

    override func scrollWheel(with event: NSEvent) {
        guard let surface else { return }
        ghostty_surface_mouse_scroll(surface, event.scrollingDeltaX, event.scrollingDeltaY, 0)
    }

    // MARK: - Focus

    override func becomeFirstResponder() -> Bool {
        surface.flatMap { ghostty_surface_set_focus($0, true) }
        return super.becomeFirstResponder()
    }

    override func resignFirstResponder() -> Bool {
        surface.flatMap { ghostty_surface_set_focus($0, false) }
        return super.resignFirstResponder()
    }

    // MARK: - Private: Paste handling

    private func handlePaste() {
        let pb = NSPasteboard.general

        // Check for image first — save to temp and paste path
        if let imageURL = ClipboardHelper.saveImageToTemp(from: pb) {
            let escapedPath = ClipboardHelper.escapeForShell(imageURL.path)
            sendText(escapedPath)
            return
        }

        // Use ClipboardHelper for enhanced paste (files, RTF, HTML, etc.)
        if let content = ClipboardHelper.pasteContent(from: pb) {
            sendText(content)
        }
    }
}
