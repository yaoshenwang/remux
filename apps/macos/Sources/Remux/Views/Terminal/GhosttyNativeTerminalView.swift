import SwiftUI

/// SwiftUI wrapper for GhosttyNativeView (libghostty Metal renderer, MANUAL io_mode).
struct GhosttyNativeTerminalView: NSViewRepresentable {
    var onWrite: ((Data) -> Void)?
    var onResize: ((Int, Int) -> Void)?
    var onBell: (() -> Void)?
    var onTitle: ((String) -> Void)?

    func makeNSView(context: Context) -> GhosttyNativeView {
        let view = GhosttyNativeView(frame: .zero)
        view.onWrite = onWrite
        view.onResize = onResize
        view.onBell = onBell
        view.onTitle = onTitle
        context.coordinator.terminalView = view
        return view
    }

    func updateNSView(_ nsView: GhosttyNativeView, context: Context) {
        nsView.onWrite = onWrite
        nsView.onResize = onResize
        nsView.onBell = onBell
        nsView.onTitle = onTitle
    }

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    class Coordinator {
        var terminalView: GhosttyNativeView?
    }
}
