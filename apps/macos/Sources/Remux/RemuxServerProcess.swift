// RemuxServerProcess: Manages an embedded Remux server (node server.js) as a child process.
// Parses stdout for token, port, and tunnel URL.

import Foundation
import AppKit

enum RemuxServerState: Equatable {
    case stopped
    case starting
    case running
    case failed(String)
}

@MainActor
final class RemuxServerProcess: ObservableObject {

    @Published var state: RemuxServerState = .stopped
    @Published var localURL: String?
    @Published var token: String?
    @Published var tunnelURL: String?
    @Published var shortCode: String?  // "847 293 015"
    @Published var port: Int = 8767

    /// Discovery service URL (local dev or production Cloudflare Worker)
    static let discoveryURL: String = {
        ProcessInfo.processInfo.environment["REMUX_DISCOVERY_URL"]
            ?? "http://localhost:8780"
    }()

    private var process: Process?
    private var stdoutPipe: Pipe?
    private var stderrPipe: Pipe?
    private var restartAttempt = 0
    private let maxRestartDelay: TimeInterval = 8
    private var isShuttingDown = false

    // MARK: - Lifecycle

    func start() {
        guard state != .starting else { return }
        isShuttingDown = false
        state = .starting
        localURL = nil
        token = nil
        tunnelURL = nil

        guard let nodePath = findNode() else {
            state = .failed("Node.js not found. Install from https://nodejs.org")
            return
        }

        guard let serverJS = findServerJS() else {
            state = .failed("server.js not found in app bundle")
            return
        }

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: nodePath)
        proc.arguments = [serverJS]

        // Generate a token for this session
        let sessionToken = generateToken()
        var env = ProcessInfo.processInfo.environment
        env["PORT"] = String(port)
        env["REMUX_TOKEN"] = sessionToken
        proc.environment = env

        // Set working directory to server.js parent (so node_modules resolves)
        proc.currentDirectoryURL = URL(fileURLWithPath: serverJS).deletingLastPathComponent()

        let stdout = Pipe()
        let stderr = Pipe()
        proc.standardOutput = stdout
        proc.standardError = stderr
        self.stdoutPipe = stdout
        self.stderrPipe = stderr

        // Parse stdout line by line
        stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let line = String(data: data, encoding: .utf8) else { return }
            Task { @MainActor [weak self] in
                self?.parseOutput(line)
            }
        }

        // Log stderr
        stderr.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            if !data.isEmpty, let line = String(data: data, encoding: .utf8) {
                // Server stderr — log but don't surface to UI unless critical
                for l in line.components(separatedBy: .newlines) where !l.isEmpty {
                    print("[remux-server stderr] \(l)")
                }
            }
        }

        proc.terminationHandler = { [weak self] proc in
            Task { @MainActor [weak self] in
                guard let self, !self.isShuttingDown else { return }
                self.process = nil
                self.stdoutPipe = nil
                self.stderrPipe = nil
                if proc.terminationStatus != 0 {
                    self.scheduleRestart()
                } else {
                    self.state = .stopped
                }
            }
        }

        do {
            try proc.run()
            self.process = proc
            // Optimistically set token (we set it via env var)
            self.token = sessionToken
        } catch {
            state = .failed("Failed to start server: \(error.localizedDescription)")
        }
    }

    func stop() {
        isShuttingDown = true
        if let proc = process, proc.isRunning {
            proc.terminate()
            // Give it 3 seconds, then force kill
            DispatchQueue.global().asyncAfter(deadline: .now() + 3) {
                if proc.isRunning {
                    proc.interrupt()
                }
            }
        }
        process = nil
        stdoutPipe?.fileHandleForReading.readabilityHandler = nil
        stderrPipe?.fileHandleForReading.readabilityHandler = nil
        stdoutPipe = nil
        stderrPipe = nil
        state = .stopped
        localURL = nil
        tunnelURL = nil
        shortCode = nil
    }

    func restart() {
        stop()
        restartAttempt = 0
        start()
    }

    // MARK: - Stdout parsing

    private func parseOutput(_ text: String) {
        for line in text.components(separatedBy: .newlines) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard !trimmed.isEmpty else { continue }

            // "Remux running at http://localhost:8767?token=xxx"
            if trimmed.contains("Remux running at") {
                if let range = trimmed.range(of: "Remux running at ") {
                    localURL = String(trimmed[range.upperBound...]).trimmingCharacters(in: .whitespaces)
                }
                state = .running
                restartAttempt = 0
            }

            // "Token: xxxx"
            if trimmed.hasPrefix("Token:") {
                let t = trimmed.dropFirst("Token:".count).trimmingCharacters(in: .whitespaces)
                if !t.isEmpty { token = t }
            }

            // "Tunnel: https://xxx.trycloudflare.com..."
            if trimmed.hasPrefix("Tunnel:") {
                let t = trimmed.dropFirst("Tunnel:".count).trimmingCharacters(in: .whitespaces)
                if !t.isEmpty {
                    tunnelURL = t
                    Task { await registerWithDiscovery(tunnelURL: t) }
                }
            }

            // Port detection from URL
            if let url = localURL, let parsed = URL(string: url), let p = parsed.port {
                port = p
            }
        }
    }

    // MARK: - Restart with backoff

    private func scheduleRestart() {
        let delay = min(pow(2.0, Double(restartAttempt)), maxRestartDelay)
        restartAttempt += 1
        state = .failed("Server crashed. Restarting in \(Int(delay))s...")
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self, !self.isShuttingDown else { return }
            self.start()
        }
    }

    // MARK: - Discovery Service

    private func registerWithDiscovery(tunnelURL: String) async {
        guard let url = URL(string: "\(Self.discoveryURL)/register") else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 10

        var body: [String: Any] = ["tunnelUrl": tunnelURL]
        if let t = token { body["token"] = t }
        guard let httpBody = try? JSONSerialization.data(withJSONObject: body) else { return }
        request.httpBody = httpBody

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse,
                  httpResponse.statusCode == 200,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let code = json["formatted"] as? String else {
                print("[discovery] registration failed")
                return
            }
            await MainActor.run { self.shortCode = code }
            print("[discovery] registered as \(code)")
        } catch {
            print("[discovery] registration error: \(error.localizedDescription)")
        }
    }

    /// Resolve a 9-digit code to a tunnel URL + token via the discovery service.
    static func resolveCode(_ code: String) async -> (tunnelUrl: String, token: String?)? {
        let cleaned = code.filter(\.isNumber)
        guard cleaned.count == 9 else { return nil }
        guard let url = URL(string: "\(discoveryURL)/resolve/\(cleaned)") else { return nil }

        do {
            let (data, response) = try await URLSession.shared.data(from: url)
            guard let httpResponse = response as? HTTPURLResponse,
                  httpResponse.statusCode == 200,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let tunnelUrl = json["tunnelUrl"] as? String else { return nil }
            return (tunnelUrl, json["token"] as? String)
        } catch {
            return nil
        }
    }

    // MARK: - Helpers

    private func findNode() -> String? {
        // 1. Bundled node
        if let bundled = Bundle.main.resourceURL?.appendingPathComponent("bin/node").path,
           FileManager.default.isExecutableFile(atPath: bundled) {
            return bundled
        }
        // 2. Common paths
        for path in ["/usr/local/bin/node", "/opt/homebrew/bin/node"] {
            if FileManager.default.isExecutableFile(atPath: path) {
                return path
            }
        }
        // 3. NVM paths
        let home = NSHomeDirectory()
        let nvmDir = "\(home)/.nvm/versions/node"
        if let versions = try? FileManager.default.contentsOfDirectory(atPath: nvmDir) {
            let sorted = versions.sorted().reversed()
            for v in sorted {
                let p = "\(nvmDir)/\(v)/bin/node"
                if FileManager.default.isExecutableFile(atPath: p) { return p }
            }
        }
        // 4. which node
        let which = Process()
        which.executableURL = URL(fileURLWithPath: "/usr/bin/which")
        which.arguments = ["node"]
        let pipe = Pipe()
        which.standardOutput = pipe
        try? which.run()
        which.waitUntilExit()
        if let data = try? pipe.fileHandleForReading.readDataToEndOfFile(),
           let path = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
           !path.isEmpty {
            return path
        }
        return nil
    }

    private func findServerJS() -> String? {
        // 1. Bundled server.js
        if let bundled = Bundle.main.resourceURL?
            .appendingPathComponent("remux-server/server.js").path,
           FileManager.default.fileExists(atPath: bundled) {
            return bundled
        }
        // 2. Dev path (remux project)
        let devPath = NSHomeDirectory() + "/dev/remux/server.js"
        if FileManager.default.fileExists(atPath: devPath) {
            return devPath
        }
        return nil
    }

    private func generateToken() -> String {
        var bytes = [UInt8](repeating: 0, count: 16)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return bytes.map { String(format: "%02x", $0) }.joined()
    }
}
