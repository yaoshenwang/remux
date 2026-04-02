import AppKit
import GhosttyKit
import UniformTypeIdentifiers

/// NSView subclass wrapping libghostty's native Metal terminal renderer.
/// Adapted for ghostty v1.3.1 API: uses `command` field to spawn a relay
/// process (`nc -U <socket>`) that bridges Unix socket <-> PTY stdio.
///
/// Data flow:
///   Remote PTY -> WebSocket -> TerminalRelay.writeToTerminal() -> socket -> nc stdout -> ghostty renders
///   User types -> ghostty -> nc stdin -> socket -> TerminalRelay.onDataFromClient -> WebSocket -> remote PTY
///
/// Supports NSTextInputClient for CJK IME and NSDraggingDestination for file drops.
///
/// Architecture ref: Calyx, Kytos (libghostty-based terminal apps)
/// IME ref: ghostty-org/ghostty macOS TerminalView NSTextInputClient
@MainActor
final class GhosttyNativeView: NSView, @preconcurrency NSTextInputClient {

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

    // MARK: - IME composing state

    /// Whether the input method is actively composing (marked text present).
    private var isComposing: Bool = false

    /// The current marked text from the input method.
    private var imeMarkedText: NSMutableAttributedString = NSMutableAttributedString()

    /// The selected range within the marked text.
    private var imeSelectedRange: NSRange = NSRange(location: NSNotFound, length: 0)

    // MARK: - File drop state

    /// Whether a drag is currently hovering over the view.
    private var isDragHighlighted: Bool = false {
        didSet {
            layer?.borderWidth = isDragHighlighted ? 2 : 0
            layer?.borderColor = isDragHighlighted
                ? NSColor.controlAccentColor.cgColor
                : nil
        }
    }

    // MARK: - Init

    /// Create the view with a relay socket path. Ghostty will spawn `nc -U <socketPath>`.
    init(frame frameRect: NSRect, socketPath: String) {
        self.relayCommand = "nc -U \(socketPath)"
        super.init(frame: frameRect)
        setupView()
        initGhostty()
    }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        setupView()
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) not supported")
    }

    deinit {
        if let surface { ghostty_surface_free(surface) }
        if let ghosttyApp { ghostty_app_free(ghosttyApp) }
    }

    private func setupView() {
        wantsLayer = true
        layer?.isOpaque = true
        layer?.backgroundColor = NSColor.black.cgColor

        // Register for file drag-and-drop
        registerForDraggedTypes([.fileURL])
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
        performBindingAction("search_forward")
    }

    /// Navigate to the previous search match.
    func searchBackward() {
        performBindingAction("search_backward")
    }

    /// Update the active search query for the surface.
    func updateSearch(_ query: String) {
        performBindingAction("search:\(query)")
    }

    private func performBindingAction(_ action: String) {
        guard let surface else { return }
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

    // MARK: - Keyboard input with IME support

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        // Do not intercept key equivalents while composing
        if isComposing { return false }

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
        // Let the input method system handle the event first (for CJK IME).
        // inputContext?.handleEvent() will call back into NSTextInputClient methods:
        // setMarkedText (composing), insertText (committed), etc.
        if inputContext?.handleEvent(event) == true {
            return
        }

        // If the input method did not handle it, send directly to ghostty
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

    override func doCommand(by selector: Selector) {
        // Called by the input method for special commands (e.g. moveLeft:, deleteBackward:).
        // We intentionally do nothing here — ghostty handles these via keyDown.
    }

    // MARK: - NSTextInputClient (CJK IME support)

    /// Whether there is currently marked (composing) text.
    func hasMarkedText() -> Bool {
        return isComposing
    }

    /// The range of the marked text within the total text storage.
    func markedRange() -> NSRange {
        if isComposing {
            return NSRange(location: 0, length: imeMarkedText.length)
        }
        return NSRange(location: NSNotFound, length: 0)
    }

    /// The range of the current selection. Returns empty range at the end.
    func selectedRange() -> NSRange {
        return imeSelectedRange
    }

    /// Called by the input method to set or update composing text.
    func setMarkedText(_ string: Any, selectedRange: NSRange, replacementRange: NSRange) {
        let attrStr: NSAttributedString
        if let s = string as? NSAttributedString {
            attrStr = s
        } else if let s = string as? String {
            attrStr = NSAttributedString(string: s)
        } else {
            return
        }

        imeMarkedText = NSMutableAttributedString(attributedString: attrStr)
        imeSelectedRange = selectedRange
        isComposing = imeMarkedText.length > 0

        // Notify ghostty that we are in a composing state
        if isComposing, let surface {
            var key = ghostty_input_key_s()
            key.action = GHOSTTY_ACTION_PRESS
            key.keycode = 0
            key.composing = true
            _ = ghostty_surface_key(surface, key)
        }

        needsDisplay = true
    }

    /// Called by the input method when composition is canceled.
    func unmarkText() {
        imeMarkedText = NSMutableAttributedString()
        imeSelectedRange = NSRange(location: NSNotFound, length: 0)
        isComposing = false
        needsDisplay = true
    }

    /// Valid attributes for marked text display.
    func validAttributesForMarkedText() -> [NSAttributedString.Key] {
        return [.underlineStyle, .foregroundColor, .backgroundColor]
    }

    /// Return attributed substring for the proposed range.
    func attributedSubstring(forProposedRange range: NSRange, actualRange: NSRangePointer?) -> NSAttributedString? {
        // We don't maintain a text storage, so return nil
        return nil
    }

    /// Called when the input method commits text (final input after composing).
    func insertText(_ string: Any, replacementRange: NSRange) {
        // Unmark first if we were composing
        let wasComposing = isComposing
        if wasComposing {
            unmarkText()
        }

        // Send the committed text to ghostty
        guard let surface else { return }
        if let str = string as? String {
            ghostty_surface_text(surface, str, UInt(str.utf8.count))
        } else if let attrStr = string as? NSAttributedString {
            let str = attrStr.string
            ghostty_surface_text(surface, str, UInt(str.utf8.count))
        }
    }

    /// Return the first rect for the character at the given range.
    /// Used by the input method to position the candidates window.
    func firstRect(forCharacterRange range: NSRange, actualRange: NSRangePointer?) -> NSRect {
        // Return a rect near the cursor position for the IME candidates window.
        // We approximate using the bottom-left of the view + some offset.
        guard let windowRef = window else {
            return NSRect(x: 0, y: 0, width: 0, height: 20)
        }

        // Use a position near the center-bottom of the view as a reasonable default
        let viewRect = NSRect(x: 0, y: bounds.height - 20, width: bounds.width, height: 20)
        let windowRect = convert(viewRect, to: nil)
        let screenRect = windowRef.convertToScreen(windowRect)
        return screenRect
    }

    /// Return the character index for a given point (used by input method).
    func characterIndex(for point: NSPoint) -> Int {
        return NSNotFound
    }

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

    // MARK: - NSDraggingDestination (File Drop Support)

    override func draggingEntered(_ sender: any NSDraggingInfo) -> NSDragOperation {
        guard sender.draggingPasteboard.canReadObject(
            forClasses: [NSURL.self],
            options: [.urlReadingFileURLsOnly: true]
        ) else {
            return []
        }
        isDragHighlighted = true
        return .copy
    }

    override func draggingUpdated(_ sender: any NSDraggingInfo) -> NSDragOperation {
        guard isDragHighlighted else { return [] }
        return .copy
    }

    override func draggingExited(_ sender: (any NSDraggingInfo)?) {
        isDragHighlighted = false
    }

    override func performDragOperation(_ sender: any NSDraggingInfo) -> Bool {
        isDragHighlighted = false

        let pb = sender.draggingPasteboard
        guard let urls = pb.readObjects(
            forClasses: [NSURL.self],
            options: [.urlReadingFileURLsOnly: true]
        ) as? [URL], !urls.isEmpty else {
            return false
        }

        // Shell-escape each path and join with spaces
        let escapedPaths = urls.map { url in
            ClipboardHelper.escapeForShell(url.path)
        }
        let text = escapedPaths.joined(separator: " ")
        sendText(text)
        return true
    }

    override func prepareForDragOperation(_ sender: any NSDraggingInfo) -> Bool {
        return true
    }

    override func concludeDragOperation(_ sender: (any NSDraggingInfo)?) {
        isDragHighlighted = false
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
