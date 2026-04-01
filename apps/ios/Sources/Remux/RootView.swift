import SwiftUI
import RemuxKit

/// Root view: shows onboarding if not connected, main TabView if connected.
struct RootView: View {
    @Environment(RemuxState.self) private var state
    private let keychain = KeychainStore()

    var body: some View {
        Group {
            if case .connected = state.connectionStatus {
                MainTabView()
            } else if case .reconnecting = state.connectionStatus {
                MainTabView()
                    .overlay(ReconnectingBanner())
            } else {
                OnboardingView()
            }
        }
        .onAppear { tryAutoConnect() }
    }

    private func tryAutoConnect() {
        // Try resume token from Keychain
        let servers = keychain.savedServers()
        if let server = servers.first,
           let token = keychain.loadResumeToken(forServer: server) ?? keychain.loadServerToken(forServer: server),
           let url = URL(string: server) {
            state.connect(url: url, credential: .token(token))
        }
    }
}

struct ReconnectingBanner: View {
    var body: some View {
        VStack {
            HStack {
                ProgressView()
                    .scaleEffect(0.8)
                Text("Reconnecting...")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding(8)
            .background(.ultraThinMaterial)
            .cornerRadius(8)
            Spacer()
        }
        .padding(.top, 8)
    }
}
