import SwiftUI
import WebKit

/// SwiftUI view wrapping ghostty-web in WKWebView.
/// Used by iOS. macOS uses GhosttyNativeTerminalView (libghostty) instead.
#if os(iOS)
public struct GhosttyTerminalView: UIViewRepresentable {
    let bridge: GhosttyBridge

    public init(bridge: GhosttyBridge) {
        self.bridge = bridge
    }

    public func makeUIView(context: Context) -> WKWebView {
        bridge.webView
    }

    public func updateUIView(_ uiView: WKWebView, context: Context) {}
}
#elseif os(macOS)
/// macOS fallback using WKWebView (prefer GhosttyNativeTerminalView for production)
public struct GhosttyTerminalView: NSViewRepresentable {
    let bridge: GhosttyBridge

    public init(bridge: GhosttyBridge) {
        self.bridge = bridge
    }

    public func makeNSView(context: Context) -> WKWebView {
        bridge.webView
    }

    public func updateNSView(_ nsView: WKWebView, context: Context) {}
}
#endif
