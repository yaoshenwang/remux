import AppKit
import SwiftUI

struct WindowObserver: NSViewRepresentable {
    var onWindowChange: (NSWindow?) -> Void

    func makeNSView(context: Context) -> WindowObserverView {
        let view = WindowObserverView()
        view.onWindowChange = onWindowChange
        return view
    }

    func updateNSView(_ nsView: WindowObserverView, context: Context) {
        nsView.onWindowChange = onWindowChange
        nsView.reportWindow()
    }
}

final class WindowObserverView: NSView {
    var onWindowChange: ((NSWindow?) -> Void)?

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        reportWindow()
    }

    override func viewDidMoveToSuperview() {
        super.viewDidMoveToSuperview()
        reportWindow()
    }

    func reportWindow() {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.onWindowChange?(self.window)
        }
    }
}
