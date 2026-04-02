import SwiftUI
import RemuxKit

/// Connection setup view — shown when not connected.
struct ConnectionView: View {
    @Environment(RemuxState.self) private var state
    @State private var serverURL = ""
    @State private var token = ""
    @State private var errorMessage: String?

    private let keychain = KeychainStore()

    var body: some View {
        VStack(spacing: 20) {
            Image(systemName: "terminal")
                .font(.system(size: 48))
                .foregroundStyle(.secondary)

            Text("Connect to Remux Server")
                .font(.title2)

            VStack(alignment: .leading, spacing: 12) {
                TextField("Server URL (e.g. http://localhost:8767)", text: $serverURL)
                    .textFieldStyle(.roundedBorder)

                SecureField("Token", text: $token)
                    .textFieldStyle(.roundedBorder)

                if let error = errorMessage {
                    Text(error)
                        .foregroundStyle(.red)
                        .font(.caption)
                }
            }
            .frame(maxWidth: 400)

            Button("Connect") {
                connect()
            }
            .buttonStyle(.borderedProminent)
            .disabled(serverURL.isEmpty || token.isEmpty)

            // Saved servers
            let savedServers = keychain.savedServers()
            if !savedServers.isEmpty {
                Divider()
                Text("Recent Servers")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                ForEach(savedServers, id: \.self) { server in
                    Button(server) {
                        serverURL = server
                        if let savedToken = keychain.loadServerToken(forServer: server) {
                            token = savedToken
                        }
                        if let credential = keychain.preferredCredential(forServer: server),
                           let url = URL(string: server) {
                            state.connect(url: url, credential: credential)
                        }
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.blue)
                }
            }
        }
        .padding(40)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func connect() {
        guard let url = URL(string: serverURL) else {
            errorMessage = "Invalid URL"
            return
        }
        errorMessage = nil
        try? keychain.saveServerToken(token, forServer: serverURL)
        state.connect(url: url, credential: .token(token))
    }
}
