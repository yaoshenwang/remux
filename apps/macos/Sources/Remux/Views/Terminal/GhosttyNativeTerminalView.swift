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
    var onSearchStart: ((String?) -> Void)?
    var onSearchEnd: (() -> Void)?
    var onSearchTotal: ((Int) -> Void)?
    var onSearchSelected: ((Int) -> Void)?

    func makeNSView(context: Context) -> GhosttyNativeView {
        let view = GhosttyNativeView(frame: .zero, socketPath: socketPath)
        view.onResize = onResize
        view.onBell = onBell
        view.onTitle = onTitle
        view.onSearchStart = onSearchStart
        view.onSearchEnd = onSearchEnd
        view.onSearchTotal = onSearchTotal
        view.onSearchSelected = onSearchSelected
        DispatchQueue.main.async { viewRef = view }
        return view
    }

    func updateNSView(_ nsView: GhosttyNativeView, context: Context) {
        nsView.onResize = onResize
        nsView.onBell = onBell
        nsView.onTitle = onTitle
        nsView.onSearchStart = onSearchStart
        nsView.onSearchEnd = onSearchEnd
        nsView.onSearchTotal = onSearchTotal
        nsView.onSearchSelected = onSearchSelected
    }
}
