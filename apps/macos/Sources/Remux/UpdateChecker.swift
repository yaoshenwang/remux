import AppKit

/// Lightweight update checker that polls GitHub releases API.
/// Adapted from Sparkle's conceptual model but without the framework dependency.
@MainActor
@Observable
final class UpdateChecker {

    // MARK: - Published state

    private(set) var latestVersion: String?
    private(set) var releaseURL: String?
    private(set) var releaseNotes: String?
    private(set) var hasUpdate: Bool = false

    // MARK: - Config

    /// GitHub API endpoint for latest release.
    static let apiURL = "https://api.github.com/repos/yaoshenwang/remux/releases/latest"

    /// Check interval: 4 hours.
    private let checkInterval: TimeInterval = 4 * 60 * 60

    /// UserDefaults key for dismissed version.
    private static let dismissedVersionKey = "UpdateChecker.dismissedVersion"

    // MARK: - Internal state

    private var timer: Timer?
    private var isChecking = false

    init() {}

    // MARK: - Public API

    /// Start the update checker: check immediately, then every 4 hours.
    func start() {
        Task { await check() }
        timer = Timer.scheduledTimer(withTimeInterval: checkInterval, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                await self?.check()
            }
        }
    }

    /// Stop the periodic check timer.
    func stop() {
        timer?.invalidate()
        timer = nil
    }

    /// Dismiss the current update notification (suppress until a newer version appears).
    func dismissCurrentUpdate() {
        guard let version = latestVersion else { return }
        UserDefaults.standard.set(version, forKey: Self.dismissedVersionKey)
        hasUpdate = false
    }

    /// Open the release page in the default browser.
    func openReleasePage() {
        guard let urlStr = releaseURL, let url = URL(string: urlStr) else {
            // Fallback to releases page
            if let url = URL(string: "https://github.com/yaoshenwang/remux/releases") {
                NSWorkspace.shared.open(url)
            }
            return
        }
        NSWorkspace.shared.open(url)
    }

    /// Force a manual check (ignores dismissed version).
    func checkNow() async {
        await check(ignoreDismissed: true)
    }

    // MARK: - Check logic

    private func check(ignoreDismissed: Bool = false) async {
        guard !isChecking else { return }
        isChecking = true
        defer { isChecking = false }

        guard let url = URL(string: Self.apiURL) else { return }

        do {
            var request = URLRequest(url: url)
            request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
            request.timeoutInterval = 15

            let (data, response) = try await URLSession.shared.data(for: request)

            guard let httpResponse = response as? HTTPURLResponse,
                  httpResponse.statusCode == 200 else {
                NSLog("[remux] Update check: non-200 response")
                return
            }

            guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let tagName = json["tag_name"] as? String else {
                NSLog("[remux] Update check: failed to parse response")
                return
            }

            let remoteVersion = tagName.hasPrefix("v") ? String(tagName.dropFirst()) : tagName
            let htmlURL = json["html_url"] as? String
            let body = json["body"] as? String

            latestVersion = remoteVersion
            releaseURL = htmlURL
            releaseNotes = body

            let currentVersion = Self.currentBundleVersion()
            let isNewer = Self.isVersion(remoteVersion, newerThan: currentVersion)

            // Check if this version was dismissed
            let dismissedVersion = UserDefaults.standard.string(forKey: Self.dismissedVersionKey)
            let isDismissed = !ignoreDismissed && dismissedVersion == remoteVersion

            hasUpdate = isNewer && !isDismissed

            if hasUpdate {
                NSLog("[remux] Update available: %@ -> %@", currentVersion, remoteVersion)
            }
        } catch {
            NSLog("[remux] Update check failed: %@", error.localizedDescription)
        }
    }

    // MARK: - Version comparison

    /// Get the current app version from the bundle, or a fallback.
    static func currentBundleVersion() -> String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
            ?? ProcessInfo.processInfo.environment["REMUX_VERSION"]
            ?? "0.0.0"
    }

    /// Compare semantic version strings. Returns true if `a` is newer than `b`.
    static func isVersion(_ a: String, newerThan b: String) -> Bool {
        let aParts = a.split(separator: ".").compactMap { Int($0) }
        let bParts = b.split(separator: ".").compactMap { Int($0) }

        let maxLen = max(aParts.count, bParts.count)
        for i in 0..<maxLen {
            let aVal = i < aParts.count ? aParts[i] : 0
            let bVal = i < bParts.count ? bParts[i] : 0
            if aVal > bVal { return true }
            if aVal < bVal { return false }
        }
        return false
    }
}
