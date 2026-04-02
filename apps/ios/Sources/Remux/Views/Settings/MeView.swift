import SwiftUI
import RemuxKit
import LocalAuthentication

/// Me tab: server management, devices, settings.
struct MeView: View {
    @Environment(RemuxState.self) private var state
    @AppStorage("faceIdEnabled") private var faceIdEnabled = false
    private let keychain = KeychainStore()

    var body: some View {
        NavigationStack {
            List {
                // Connection
                Section("Connection") {
                    HStack {
                        Circle()
                            .fill(state.connectionStatus.color)
                            .frame(width: 8, height: 8)
                        Text(state.connectionStatus.text)
                        Spacer()
                        if let url = state.serverURL {
                            Text(url.host ?? "")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }

                    if case .connected = state.connectionStatus {
                        Button("Disconnect", role: .destructive) {
                            state.disconnect()
                        }
                    }
                }

                // Saved servers
                Section("Servers") {
                    ForEach(keychain.savedServers(), id: \.self) { server in
                        HStack {
                            Image(systemName: "server.rack")
                            Text(server)
                                .font(.subheadline)
                            Spacer()
                            if state.serverURL?.absoluteString == server {
                                Image(systemName: "checkmark")
                                    .foregroundStyle(.tint)
                            }
                        }
                        .swipeActions {
                            Button(role: .destructive) {
                                keychain.deleteAll(forServer: server)
                            } label: {
                                Label("Delete", systemImage: "trash")
                            }
                        }
                    }
                }

                // Devices
                if !state.devices.isEmpty {
                    Section("Devices") {
                        ForEach(state.devices, id: \.id) { device in
                            HStack {
                                Image(systemName: deviceIcon(device.platform))
                                VStack(alignment: .leading) {
                                    Text(device.name ?? device.id.prefix(8).description)
                                        .font(.subheadline)
                                    Text(device.trust)
                                        .font(.caption)
                                        .foregroundStyle(device.trust == "trusted" ? .green : .orange)
                                }
                                Spacer()
                                if let lastSeen = device.lastSeen {
                                    Text(Self.lastSeenFormatter.string(from: Date(timeIntervalSince1970: TimeInterval(lastSeen) / 1000)))
                                        .font(.caption2)
                                        .foregroundStyle(.tertiary)
                                }
                            }
                        }
                    }
                }

                // Settings
                Section("Security") {
                    Toggle("Face ID / Touch ID", isOn: $faceIdEnabled)
                }

                // App info
                Section("About") {
                    HStack {
                        Text("Version")
                        Spacer()
                        Text(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.3.9")
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle("Me")
            .onAppear {
                // Request device list
                state.sendJSON(["type": "list_devices"])
            }
        }
    }

    private func deviceIcon(_ platform: String?) -> String {
        switch platform {
        case "ios": "iphone"
        case "macos": "desktopcomputer"
        case "android": "apps.iphone"
        case "web": "globe"
        default: "questionmark.circle"
        }
    }

    private static let lastSeenFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .short
        formatter.timeStyle = .short
        return formatter
    }()
}

extension ConnectionStatus {
    var color: Color {
        switch self {
        case .connected: .green
        case .reconnecting: .yellow
        case .connecting, .authenticating: .orange
        case .disconnected: .red
        }
    }

    var text: String {
        switch self {
        case .connected: "Connected"
        case .reconnecting(let n): "Reconnecting (\(n))..."
        case .connecting: "Connecting..."
        case .authenticating: "Authenticating..."
        case .disconnected: "Disconnected"
        }
    }
}
