import SwiftUI
import RemuxKit

/// Manual connection entry: URL + token.
struct ManualConnectView: View {
    @Environment(RemuxState.self) private var state
    @Environment(\.dismiss) private var dismiss
    @State private var serverURL = ""
    @State private var token = ""
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Server") {
                    TextField("URL (e.g. http://192.168.1.100:8767)", text: $serverURL)
                        .textContentType(.URL)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)

                    SecureField("Token", text: $token)
                }

                if let error = errorMessage {
                    Section {
                        Text(error)
                            .foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("Connect")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Connect") { connect() }
                        .disabled(serverURL.isEmpty || token.isEmpty)
                }
            }
        }
    }

    private func connect() {
        guard let url = URL(string: serverURL) else {
            errorMessage = "Invalid URL"
            return
        }
        let keychain = KeychainStore()
        try? keychain.saveServerToken(token, forServer: serverURL)
        state.connect(url: url, credential: .token(token))
        dismiss()
    }
}
