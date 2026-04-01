import SwiftUI
import RemuxKit

/// SwiftUI wrapper for GhosttyNativeView (libghostty Metal renderer).
/// The relay socket path is used to create the ghostty surface with `nc -U` as its command.
struct GhosttyNativeTerminalView: NSViewRepresentable {
    let socketPath: String
    @Binding var viewRef: GhosttyNativeView?
    var onResize: ((Int, Int) -> Void)?
    var onBell: (() -> Void)?
    var onTitle: ((String) -> Void)?

    func makeNSView(context: Context) -> GhosttyNativeView {
        let view = GhosttyNativeView(frame: .zero, socketPath: socketPath)
        view.onResize = onResize
        view.onBell = onBell
        view.onTitle = onTitle
        DispatchQueue.main.async { viewRef = view }
        return view
    }

    func updateNSView(_ nsView: GhosttyNativeView, context: Context) {
        nsView.onResize = onResize
        nsView.onBell = onBell
        nsView.onTitle = onTitle
    }
}
