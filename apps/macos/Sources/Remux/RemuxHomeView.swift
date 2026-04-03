// RemuxHomeView: RustDesk-like home panel.
// Shows host status (this device) and remote connection input.

import SwiftUI

struct RemuxHomeView: View {
    @ObservedObject var serverProcess: RemuxServerProcess
    @EnvironmentObject var tabManager: TabManager

    @State private var remoteURL: String = ""
    @State private var remoteToken: String = ""
    @State private var connectError: String?
    @State private var isResolving: Bool = false
    @ObservedObject private var history = RemuxConnectionHistory.shared

    var body: some View {
        ScrollView {
            VStack(spacing: 24) {
                Spacer().frame(height: 20)

                // Title
                Text("Remux")
                    .font(.largeTitle.bold())

                // Host section
                hostSection

                // Client section
                clientSection

                // New local terminal
                Button(action: newLocalTerminal) {
                    Label("New Local Terminal", systemImage: "terminal")
                        .frame(maxWidth: 360)
                }
                .buttonStyle(.bordered)
                .controlSize(.large)

                // Connection history
                if !history.entries.isEmpty {
                    historySection
                }

                Spacer()
            }
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 40)
        }
    }

    // MARK: - Host Section

    private var hostSection: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 10) {
                Label("This Device", systemImage: "desktopcomputer")
                    .font(.headline)

                HStack {
                    Circle()
                        .fill(serverStatusColor)
                        .frame(width: 8, height: 8)
                    Text(serverStatusText)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }

                if let code = serverProcess.shortCode {
                    HStack {
                        Text("ID")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .frame(width: 50, alignment: .trailing)
                        Text(code)
                            .font(.system(size: 20, weight: .bold, design: .monospaced))
                            .textSelection(.enabled)
                        Button(action: { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(code, forType: .string) }) {
                            Image(systemName: "doc.on.doc")
                                .font(.caption)
                        }
                        .buttonStyle(.plain)
                    }
                }

                if let url = serverProcess.localURL {
                    infoRow(label: "Local", value: url)
                }

                if let tunnel = serverProcess.tunnelURL {
                    infoRow(label: "Tunnel", value: tunnel)

                    // QR code for tunnel URL
                    if let qrImage = Self.generateQRCode(from: tunnel) {
                        Image(nsImage: qrImage)
                            .interpolation(.none)
                            .resizable()
                            .scaledToFit()
                            .frame(width: 120, height: 120)
                            .padding(.top, 4)
                    }
                }

                if let token = serverProcess.token {
                    HStack {
                        Text("Token")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .frame(width: 50, alignment: .trailing)
                        Text(token)
                            .font(.system(.caption, design: .monospaced))
                            .lineLimit(1)
                            .textSelection(.enabled)
                        Button(action: { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(token, forType: .string) }) {
                            Image(systemName: "doc.on.doc")
                                .font(.caption)
                        }
                        .buttonStyle(.plain)
                    }
                }

                if case .failed(let msg) = serverProcess.state {
                    Text(msg)
                        .font(.caption)
                        .foregroundStyle(.red)

                    Button("Restart Server") {
                        serverProcess.restart()
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                }
            }
            .padding(8)
        }
        .frame(maxWidth: 400)
    }

    // MARK: - Client Section

    private var clientSection: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 10) {
                Label("Connect to Remote", systemImage: "network")
                    .font(.headline)

                HStack {
                    Text("ID")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .frame(width: 50, alignment: .trailing)
                    TextField("123 456 789 or ws://host:port/ws", text: $remoteURL)
                        .textFieldStyle(.plain)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(.quaternary)
                        .clipShape(RoundedRectangle(cornerRadius: 6))
                }

                HStack {
                    Text("Token")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .frame(width: 50, alignment: .trailing)
                    SecureField("Authentication token", text: $remoteToken)
                        .textFieldStyle(.plain)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(.quaternary)
                        .clipShape(RoundedRectangle(cornerRadius: 6))
                }

                if let error = connectError {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(.red)
                }

                HStack {
                    Spacer()
                    Button(action: {
                        Task { await connectToRemote() }
                    }) {
                        HStack(spacing: 4) {
                            if isResolving {
                                ProgressView().controlSize(.small)
                            }
                            Text(isResolving ? "Resolving..." : "Connect")
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.regular)
                    .disabled(remoteURL.isEmpty || isResolving)
                }
            }
            .padding(8)
        }
        .frame(maxWidth: 400)
    }

    // MARK: - History Section

    private var historySection: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 8) {
                Label("Recent Connections", systemImage: "clock")
                    .font(.headline)

                ForEach(history.entries.prefix(5)) { entry in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(entry.label)
                                .font(.system(.caption, design: .monospaced))
                            Text(history.relativeTime(for: entry.lastConnected))
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                        }
                        Spacer()
                        Button("Connect") {
                            if let token = history.token(for: entry.id) {
                                remoteURL = entry.url
                                remoteToken = token
                                Task { await connectToRemote() }
                            }
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        Button(action: { history.remove(id: entry.id) }) {
                            Image(systemName: "xmark")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .padding(8)
        }
        .frame(maxWidth: 400)
    }

    // MARK: - Actions

    private func newLocalTerminal() {
        tabManager.addWorkspace(remuxKind: .local)
    }

    private func connectToRemote() async {
        connectError = nil
        let input = remoteURL.trimmingCharacters(in: .whitespacesAndNewlines)
        let inputToken = remoteToken.trimmingCharacters(in: .whitespacesAndNewlines)

        var resolvedURL: String
        var resolvedToken: String = inputToken

        // Check if input is a 9-digit code (with optional spaces/dashes)
        let digits = input.filter(\.isNumber)
        if digits.count == 9 && input.filter(\.isLetter).isEmpty {
            // Resolve short code via discovery service
            isResolving = true
            defer { isResolving = false }
            guard let result = await RemuxServerProcess.resolveCode(digits) else {
                connectError = "Code not found or expired"
                return
            }
            // Convert tunnel HTTPS URL to WebSocket URL
            resolvedURL = result.tunnelUrl
                .replacingOccurrences(of: "https://", with: "wss://")
                .replacingOccurrences(of: "http://", with: "ws://")
            if let t = result.token, resolvedToken.isEmpty {
                resolvedToken = t
            }
        } else {
            resolvedURL = input
        }

        // Auto-fix URL
        if !resolvedURL.hasPrefix("ws://") && !resolvedURL.hasPrefix("wss://") {
            resolvedURL = "ws://" + resolvedURL
        }
        if !resolvedURL.contains("/ws") {
            resolvedURL = resolvedURL.hasSuffix("/") ? resolvedURL + "ws" : resolvedURL + "/ws"
        }
        // Strip query params for the WS URL (token goes via auth message)
        if let u = URL(string: resolvedURL), let comps = URLComponents(url: u, resolvingAgainstBaseURL: false) {
            // Extract token from URL query if present
            if let urlToken = comps.queryItems?.first(where: { $0.name == "token" })?.value,
               resolvedToken.isEmpty {
                resolvedToken = urlToken
            }
            var clean = comps
            clean.queryItems = nil
            if let cleanURL = clean.url?.absoluteString {
                resolvedURL = cleanURL
            }
        }

        guard URL(string: resolvedURL) != nil else {
            connectError = "Invalid URL"
            return
        }

        if resolvedToken.isEmpty {
            connectError = "Token required"
            return
        }

        // Find bridge executable
        let bridgePath: String
        if let bundled = Bundle.main.resourceURL?.appendingPathComponent("bin/remux-bridge").path,
           FileManager.default.isExecutableFile(atPath: bundled) {
            bridgePath = bundled
        } else if let devPath = findDevBridge() {
            bridgePath = devPath
        } else {
            connectError = "remux-bridge not found"
            return
        }

        let env: [String: String] = [
            "REMUX_URL": resolvedURL,
            "REMUX_TOKEN": resolvedToken,
        ]

        let host = URL(string: resolvedURL)?.host ?? "Remote"

        // Save to connection history
        RemuxConnectionHistory.shared.add(url: resolvedURL, token: resolvedToken, label: host)

        tabManager.addWorkspace(
            title: host,
            initialTerminalCommand: bridgePath,
            initialTerminalEnvironment: env,
            remuxKind: .remote(url: resolvedURL, label: host)
        )
    }

    private func findDevBridge() -> String? {
        let candidates = [
            NSHomeDirectory() + "/dev/remux/Bridge/.build/debug/remux-bridge",
            NSHomeDirectory() + "/dev/remux/Bridge/.build/release/remux-bridge",
        ]
        return candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) })
    }

    // MARK: - QR Code

    static func generateQRCode(from string: String) -> NSImage? {
        guard let data = string.data(using: .ascii),
              let filter = CIFilter(name: "CIQRCodeGenerator") else { return nil }
        filter.setValue(data, forKey: "inputMessage")
        filter.setValue("M", forKey: "inputCorrectionLevel")
        guard let output = filter.outputImage else { return nil }
        // Scale up from tiny QR to usable size
        let scale = CGAffineTransform(scaleX: 10, y: 10)
        let scaled = output.transformed(by: scale)
        let rep = NSCIImageRep(ciImage: scaled)
        let image = NSImage(size: rep.size)
        image.addRepresentation(rep)
        return image
    }

    // MARK: - Helpers

    private var serverStatusColor: Color {
        switch serverProcess.state {
        case .running: return .green
        case .starting: return .orange
        case .stopped: return .gray
        case .failed: return .red
        }
    }

    private var serverStatusText: String {
        switch serverProcess.state {
        case .running: return "Running"
        case .starting: return "Starting..."
        case .stopped: return "Stopped"
        case .failed(let msg): return msg
        }
    }

    private func infoRow(label: String, value: String) -> some View {
        HStack {
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(width: 50, alignment: .trailing)
            Text(value)
                .font(.system(.caption, design: .monospaced))
                .lineLimit(1)
                .textSelection(.enabled)
        }
    }
}
