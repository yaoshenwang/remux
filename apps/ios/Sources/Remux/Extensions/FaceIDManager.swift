import LocalAuthentication
import SwiftUI

/// Face ID / Touch ID authentication manager.
@MainActor
final class FaceIDManager {
    @AppStorage("faceIdEnabled") private var faceIdEnabled = false

    func authenticateIfNeeded() async -> Bool {
        guard faceIdEnabled else { return true }

        let context = LAContext()
        var error: NSError?

        guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) else {
            return true // No biometrics available, skip
        }

        do {
            let success = try await context.evaluatePolicy(
                .deviceOwnerAuthenticationWithBiometrics,
                localizedReason: "Unlock Remux to access your terminal sessions"
            )
            return success
        } catch {
            return false
        }
    }
}
