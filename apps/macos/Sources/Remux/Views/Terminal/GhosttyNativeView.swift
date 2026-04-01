import AppKit
import GhosttyKit

/// NSView subclass wrapping libghostty's native Metal terminal renderer.
/// Uses MANUAL io_mode: no local shell spawned. Data flows via callbacks:
///   PTY output (from WebSocket) → ghostty_surface_process_output() → VT parser → Metal render
///   User keystrokes → io_write_cb → onWrite callback → WebSocket → remote PTY
///
/// Architecture ref: cmux GhosttyTerminalView.swift (GPL — design patterns only, no code copied)
@MainActor
final class GhosttyNativeView: NSView {

    // MARK: - Callbacks

    /// Called when user types — data should be sent to remote PTY via WebSocket
    var onWrite: ((Data) -> Void)?
    var onResize: ((Int, Int) -> Void)?
    var onBell: (() -> Void)?
    var onTitle: ((String) -> Void)?

    // MARK: - Ghostty state (nonisolated for deinit cleanup)

    nonisolated(unsafe) private var ghosttyApp: ghostty_app_t?
    nonisolated(unsafe) private var surface: ghostty_surface_t?

    // MARK: - Init

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.isOpaque = true
        layer?.backgroundColor = NSColor.black.cgColor
        initGhostty()
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
        rtConfig.supports_selection_clipboard = false

        rtConfig.wakeup_cb = { ud in
            guard let ud else { return }
            let view = Unmanaged<GhosttyNativeView>.fromOpaque(ud).takeUnretainedValue()
            DispatchQueue.main.async {
                view.needsDisplay = true
            }
        }

        rtConfig.action_cb = { _, _, _ in false }

        rtConfig.read_clipboard_cb = { _, _, _ in false }

        rtConfig.confirm_read_clipboard_cb = { _, _, _, _ in }

        rtConfig.write_clipboard_cb = { _, _, content, count, _ in
            guard let content, count > 0, let data = content.pointee.data else { return }
            let str = String(cString: data)
            let pb = NSPasteboard.general
            pb.clearContents()
            pb.setString(str, forType: .string)
        }

        rtConfig.close_surface_cb = { _, _ in }

        ghosttyApp = ghostty_app_new(&rtConfig, config)
        ghostty_config_free(config)
        guard let ghosttyApp else { return }

        // Surface config with MANUAL io_mode
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

        // MANUAL mode: don't spawn a shell, use callbacks for I/O
        surfaceConfig.io_mode = 1 // GHOSTTY_SURFACE_IO_MANUAL
        surfaceConfig.io_write_userdata = Unmanaged.passUnretained(self).toOpaque()
        surfaceConfig.io_write_cb = { ud, data, len in
            // User typed something → forward to remote PTY
            guard let ud, let data, len > 0 else { return }
            let view = Unmanaged<GhosttyNativeView>.fromOpaque(ud).takeUnretainedValue()
            let bytes = Data(bytes: data, count: Int(len))
            DispatchQueue.main.async {
                view.onWrite?(bytes)
            }
        }

        surface = ghostty_surface_new(ghosttyApp, &surfaceConfig)
    }

    // MARK: - Public API: feed PTY data from remote server

    /// Feed remote PTY output into the terminal for rendering.
    /// Call this with data received from the WebSocket.
    func processOutput(_ data: Data) {
        guard let surface else { return }
        data.withUnsafeBytes { ptr in
            guard let baseAddr = ptr.baseAddress else { return }
            ghostty_surface_process_output(
                surface,
                baseAddr.assumingMemoryBound(to: CChar.self),
                UInt(ptr.count)
            )
        }
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

    // MARK: - Keyboard input

    override func keyDown(with event: NSEvent) {
        interpretKeyEvents([event])
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
}
