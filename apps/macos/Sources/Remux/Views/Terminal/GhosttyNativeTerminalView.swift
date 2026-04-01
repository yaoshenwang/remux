import SwiftUI

/// SwiftUI wrapper for GhosttyNativeView (libghostty Metal renderer).
struct GhosttyNativeTerminalView: NSViewRepresentable {
    var onResize: ((Int, Int) -> Void)?
    var onBell: (() -> Void)?
    var onTitle: ((String) -> Void)?

    func makeNSView(context: Context) -> GhosttyNativeView {
        let view = GhosttyNativeView(frame: .zero)
        view.onResize = onResize
        view.onBell = onBell
        view.onTitle = onTitle
        return view
    }

    func updateNSView(_ nsView: GhosttyNativeView, context: Context) {
        nsView.onResize = onResize
        nsView.onBell = onBell
        nsView.onTitle = onTitle
    }
}
