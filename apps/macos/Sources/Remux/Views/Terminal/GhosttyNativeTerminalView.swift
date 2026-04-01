import SwiftUI
import RemuxKit

/// SwiftUI wrapper for GhosttyNativeView (libghostty Metal renderer, MANUAL io_mode).
/// Uses Coordinator to maintain a reference to the underlying NSView for processOutput().
struct GhosttyNativeTerminalView: NSViewRepresentable {
    @Binding var viewRef: GhosttyNativeView?
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
        DispatchQueue.main.async { viewRef = view }
        return view
    }

    func updateNSView(_ nsView: GhosttyNativeView, context: Context) {
        nsView.onWrite = onWrite
        nsView.onResize = onResize
        nsView.onBell = onBell
        nsView.onTitle = onTitle
    }
}
