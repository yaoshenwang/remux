import SwiftUI
import RemuxKit

/// First-launch onboarding: scan QR or manual input.
struct OnboardingView: View {
    @Environment(RemuxState.self) private var state
    @State private var showScanner = false
    @State private var showManualInput = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 32) {
                Spacer()

                Image(systemName: "terminal")
                    .font(.system(size: 64))
                    .foregroundStyle(.tint)

                Text("Remux")
                    .font(.largeTitle.bold())

                Text("Remote terminal workspace")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)

                Spacer()

                VStack(spacing: 16) {
                    Button(action: { showScanner = true }) {
                        Label("Scan QR Code", systemImage: "qrcode.viewfinder")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)

                    Button(action: { showManualInput = true }) {
                        Label("Enter Manually", systemImage: "keyboard")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.large)
                }
                .padding(.horizontal, 40)

                Spacer()
            }
            .sheet(isPresented: $showScanner) {
                QRScannerView { payload in
                    showScanner = false
                    handleQRPayload(payload)
                }
            }
            .sheet(isPresented: $showManualInput) {
                ManualConnectView()
            }
        }
    }

    private func handleQRPayload(_ json: String) {
        guard let data = json.data(using: .utf8),
              let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let urlStr = dict["url"] as? String,
              let token = dict["token"] as? String,
              let url = URL(string: urlStr) else { return }

        let keychain = KeychainStore()
        try? keychain.saveServerToken(token, forServer: urlStr)
        state.connect(url: url, credential: .token(token))
    }
}
