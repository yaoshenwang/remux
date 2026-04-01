import AppKit
import WebKit
import SwiftUI

/// Panel type for identifying what kind of panel a split leaf holds.
enum PanelType: String, Codable, Sendable {
    case terminal
    case browser
    case markdown
}

/// WKWebView-based browser panel for embedding in the split pane system.
/// Conforms to PanelProtocol. Triggered by Cmd+Shift+B or menu item.
/// Adapted from wave-terminal browser panel pattern.
@MainActor
final class BrowserPanel: NSObject, PanelProtocol, WKNavigationDelegate {
    let id: UUID
    private(set) var isFocused = false
    private(set) var currentURL: URL?
    private(set) var pageTitle: String?
    private(set) var canGoBack: Bool = false
    private(set) var canGoForward: Bool = false
    private(set) var isLoading: Bool = false

    let webView: WKWebView

    var title: String {
        pageTitle ?? currentURL?.host ?? "Browser"
    }

    var canClose: Bool { true }

    /// Called when navigation state changes (URL, title, loading, back/forward).
    var onStateChange: (() -> Void)?

    init(id: UUID = UUID(), url: URL? = nil) {
        self.id = id

        let config = WKWebViewConfiguration()
        config.preferences.isElementFullscreenEnabled = true
        self.webView = WKWebView(frame: .zero, configuration: config)

        super.init()

        webView.navigationDelegate = self
        webView.allowsBackForwardNavigationGestures = true

        if let url {
            navigate(to: url)
        } else {
            navigate(to: URL(string: "https://www.google.com")!)
        }
    }

    func focus() { isFocused = true }
    func blur() { isFocused = false }

    // MARK: - Navigation

    func navigate(to url: URL) {
        let request = URLRequest(url: url)
        webView.load(request)
    }

    func navigateToString(_ urlString: String) {
        var str = urlString.trimmingCharacters(in: .whitespacesAndNewlines)
        if !str.contains("://") {
            if str.contains(".") && !str.contains(" ") {
                str = "https://" + str
            } else {
                str = "https://www.google.com/search?q=" + (str.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? str)
            }
        }
        guard let url = URL(string: str) else { return }
        navigate(to: url)
    }

    func goBack() { webView.goBack() }
    func goForward() { webView.goForward() }
    func reload() { webView.reload() }

    // MARK: - WKNavigationDelegate

    nonisolated func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        Task { @MainActor in
            self.currentURL = webView.url
            self.pageTitle = webView.title
            self.canGoBack = webView.canGoBack
            self.canGoForward = webView.canGoForward
            self.isLoading = false
            self.onStateChange?()
        }
    }

    nonisolated func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        Task { @MainActor in
            self.isLoading = true
            self.currentURL = webView.url
            self.onStateChange?()
        }
    }

    nonisolated func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        Task { @MainActor in
            self.isLoading = false
            self.onStateChange?()
        }
    }

    nonisolated func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        Task { @MainActor in
            self.currentURL = webView.url
            self.canGoBack = webView.canGoBack
            self.canGoForward = webView.canGoForward
            self.onStateChange?()
        }
    }
}

// MARK: - BrowserPanelView (SwiftUI)

/// SwiftUI view wrapping a BrowserPanel with toolbar (back, forward, refresh, URL bar).
struct BrowserPanelView: View {
    @State private var panel: BrowserPanel
    @State private var urlText: String = ""
    @State private var refreshID: UUID = UUID()

    init(panel: BrowserPanel) {
        _panel = State(initialValue: panel)
        _urlText = State(initialValue: panel.currentURL?.absoluteString ?? "")
    }

    var body: some View {
        VStack(spacing: 0) {
            // Toolbar
            HStack(spacing: 6) {
                Button(action: { panel.goBack() }) {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 12, weight: .medium))
                }
                .buttonStyle(.borderless)
                .disabled(!panel.canGoBack)

                Button(action: { panel.goForward() }) {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 12, weight: .medium))
                }
                .buttonStyle(.borderless)
                .disabled(!panel.canGoForward)

                Button(action: { panel.reload() }) {
                    Image(systemName: panel.isLoading ? "xmark" : "arrow.clockwise")
                        .font(.system(size: 11, weight: .medium))
                }
                .buttonStyle(.borderless)

                TextField("URL", text: $urlText)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(size: 12))
                    .onSubmit {
                        panel.navigateToString(urlText)
                    }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(.bar)

            Divider()

            // Web content
            BrowserWebViewRepresentable(webView: panel.webView)
                .id(refreshID)
        }
        .onAppear {
            panel.onStateChange = { [weak panel] in
                guard let panel else { return }
                urlText = panel.currentURL?.absoluteString ?? ""
                refreshID = UUID()
            }
        }
    }
}

/// NSViewRepresentable wrapping WKWebView.
struct BrowserWebViewRepresentable: NSViewRepresentable {
    let webView: WKWebView

    func makeNSView(context: Context) -> WKWebView {
        return webView
    }

    func updateNSView(_ nsView: WKWebView, context: Context) {}
}
