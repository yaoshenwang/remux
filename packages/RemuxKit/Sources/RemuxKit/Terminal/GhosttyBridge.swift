import Foundation
import WebKit

/// Bridge between Swift and ghostty-web running in WKWebView.
/// Used by iOS (and macOS WKWebView fallback if needed).
/// Communication:
///   Swift → JS:  webView.evaluateJavaScript("terminal.write(...)")
///   JS → Swift:  webkit.messageHandlers.remux.postMessage({type, data})
@MainActor
public final class GhosttyBridge: NSObject, WKScriptMessageHandler {

    public let webView: WKWebView

    public var onInput: ((String) -> Void)?
    public var onResize: ((Int, Int) -> Void)?
    public var onReady: (() -> Void)?
    public var onBell: (() -> Void)?

    public init(frame: CGRect = .zero) {
        let config = WKWebViewConfiguration()
        config.preferences.setValue(true, forKey: "allowFileAccessFromFileURLs")

        // Disable zoom on iOS
        let viewportScript = WKUserScript(
            source: "var meta = document.createElement('meta'); meta.name = 'viewport'; meta.content = 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no'; document.head.appendChild(meta);",
            injectionTime: .atDocumentEnd,
            forMainFrameOnly: true
        )
        config.userContentController.addUserScript(viewportScript)

        webView = WKWebView(frame: frame, configuration: config)

        #if os(iOS)
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.bounces = false
        #endif

        super.init()

        config.userContentController.add(self, name: "remux")
        loadTerminalHTML()
    }

    // MARK: - Swift → JS

    /// Write PTY data to the terminal (base64 encoded to avoid escaping issues)
    public func writeToTerminal(data: Data) {
        let base64 = data.base64EncodedString()
        webView.evaluateJavaScript("window.terminalBridge.write('\(base64)')") { _, _ in }
    }

    /// Write string data to the terminal
    public func writeString(_ string: String) {
        if let data = string.data(using: .utf8) {
            writeToTerminal(data: data)
        }
    }

    /// Resize the terminal
    public func resize(cols: Int, rows: Int) {
        webView.evaluateJavaScript("window.terminalBridge.resize(\(cols), \(rows))") { _, _ in }
    }

    /// Set terminal theme
    public func setTheme(_ config: [String: String]) {
        if let data = try? JSONSerialization.data(withJSONObject: config),
           let json = String(data: data, encoding: .utf8) {
            webView.evaluateJavaScript("window.terminalBridge.setTheme(\(json))") { _, _ in }
        }
    }

    // MARK: - JS → Swift (WKScriptMessageHandler)

    public func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let type = body["type"] as? String else { return }

        switch type {
        case "input":
            if let data = body["data"] as? String {
                onInput?(data)
            }
        case "resize":
            if let cols = body["cols"] as? Int, let rows = body["rows"] as? Int {
                onResize?(cols, rows)
            }
        case "ready":
            onReady?()
        case "bell":
            onBell?()
        default:
            break
        }
    }

    // MARK: - HTML loading

    private func loadTerminalHTML() {
        // Load from bundle resources
        if let resourceURL = Bundle.module.url(forResource: "ghostty-terminal", withExtension: "html", subdirectory: "Terminal/Resources") {
            webView.loadFileURL(resourceURL, allowingReadAccessTo: resourceURL.deletingLastPathComponent())
        } else {
            // Fallback: load inline minimal HTML for development
            let html = Self.fallbackHTML
            webView.loadHTMLString(html, baseURL: nil)
        }
    }

    /// Minimal fallback HTML when bundle resources are not yet available
    private static let fallbackHTML = """
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8">
        <style>
            body { margin: 0; background: #1a1a2e; color: #e0e0e0; font-family: monospace; padding: 20px; }
        </style>
    </head>
    <body>
        <p>ghostty-web resources not found. Run scripts/sync-ghostty-web.sh to bundle them.</p>
        <script>
            window.terminalBridge = {
                write: function(b64) {},
                resize: function(c, r) {},
                setTheme: function(t) {}
            };
            window.webkit.messageHandlers.remux.postMessage({type: 'ready', cols: 80, rows: 24});
        </script>
    </body>
    </html>
    """
}
