// ConnectionView: UI for connecting to a Remux server.
// Shown when the app is not connected to any server.

import SwiftUI

struct ConnectionView: View {
    @ObservedObject var sessionManager: RemuxSessionManager

    @State private var urlText: String = ""
    @State private var tokenText: String = ""
    @State private var isConnecting = false

    var body: some View {
        VStack(spacing: 0) {
            Spacer()

            VStack(spacing: 24) {
                // Logo / Title
                VStack(spacing: 8) {
                    Image(systemName: "terminal")
                        .font(.system(size: 48))
                        .foregroundStyle(.secondary)
                    Text("Remux")
                        .font(.largeTitle.bold())
                    Text("Connect to a Remux server")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }

                // Input fields
                VStack(spacing: 12) {
                    HStack {
                        Image(systemName: "globe")
                            .foregroundStyle(.secondary)
                            .frame(width: 20)
                        TextField("Server URL", text: $urlText, prompt: Text("ws://192.168.1.100:8767/ws"))
                            .textFieldStyle(.plain)
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(.quaternary)
                    .clipShape(RoundedRectangle(cornerRadius: 8))

                    HStack {
                        Image(systemName: "key")
                            .foregroundStyle(.secondary)
                            .frame(width: 20)
                        SecureField("Token", text: $tokenText, prompt: Text("Authentication token"))
                            .textFieldStyle(.plain)
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(.quaternary)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                }
                .frame(maxWidth: 360)

                // Error message
                if let error = sessionManager.errorMessage {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(.red)
                }

                // Status
                if case .reconnecting(let attempt) = sessionManager.status {
                    Text("Reconnecting (attempt \(attempt))...")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }

                // Connect button
                Button(action: doConnect) {
                    HStack(spacing: 6) {
                        if isConnecting {
                            ProgressView()
                                .controlSize(.small)
                        }
                        Text(isConnecting ? "Connecting..." : "Connect")
                    }
                    .frame(minWidth: 120)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(isConnecting || urlText.isEmpty || tokenText.isEmpty)
                .keyboardShortcut(.defaultAction)
            }
            .padding(40)

            Spacer()

            // Recent connections
            if let saved = RemuxSessionManager.loadCredentials() {
                VStack(spacing: 8) {
                    Divider()
                    HStack {
                        Image(systemName: "clock")
                            .foregroundStyle(.secondary)
                        Text("Last: \(saved.url.host ?? saved.url.absoluteString)")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Button("Reconnect") {
                            urlText = saved.url.absoluteString
                            tokenText = saved.token
                            doConnect()
                        }
                        .buttonStyle(.plain)
                        .font(.caption.bold())
                        .foregroundStyle(.blue)
                    }
                    .padding(.bottom, 12)
                }
            }
        }
        .frame(minWidth: 400, minHeight: 400)
        .onAppear {
            // Auto-fill from saved credentials
            if let saved = RemuxSessionManager.loadCredentials() {
                urlText = saved.url.absoluteString
                tokenText = saved.token
            }
            // Auto-fill from environment
            if let envURL = ProcessInfo.processInfo.environment["REMUX_URL"] {
                urlText = envURL
            }
            if let envToken = ProcessInfo.processInfo.environment["REMUX_TOKEN"] {
                tokenText = envToken
            }
        }
        .onChange(of: sessionManager.status) { _, newStatus in
            switch newStatus {
            case .connected:
                isConnecting = false
            case .disconnected:
                isConnecting = false
            default:
                break
            }
        }
    }

    private func doConnect() {
        var url = urlText.trimmingCharacters(in: .whitespacesAndNewlines)
        // Auto-append /ws if user just provides host:port
        if !url.contains("/ws") {
            if url.hasSuffix("/") {
                url += "ws"
            } else {
                url += "/ws"
            }
        }
        // Auto-prepend ws:// if no scheme
        if !url.hasPrefix("ws://") && !url.hasPrefix("wss://") {
            url = "ws://" + url
        }
        guard let wsURL = URL(string: url) else {
            sessionManager.errorMessage = "Invalid URL"
            return
        }
        isConnecting = true
        sessionManager.connect(url: wsURL, token: tokenText.trimmingCharacters(in: .whitespacesAndNewlines))
        sessionManager.saveCredentials()
    }
}
