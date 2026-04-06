import Foundation

/// Parsed SSH host entry from ~/.ssh/config
struct SSHHost: Identifiable, Sendable, Equatable {
    let id: String // Host alias
    let hostname: String?
    let user: String?
    let port: Int?
    let identityFile: String?

    var displayName: String {
        if let user, let hostname {
            return "\(user)@\(hostname)"
        }
        return hostname ?? id
    }
}

/// Parses ~/.ssh/config to extract configured hosts.
enum SSHHostManager {
    struct PreparationResult: Equatable {
        let host: SSHHost?
        let message: String?

        var isReady: Bool {
            host != nil
        }

        static func ready(_ host: SSHHost) -> PreparationResult {
            .init(host: host, message: nil)
        }

        static func failure(_ message: String) -> PreparationResult {
            .init(host: nil, message: message)
        }
    }

    private struct CommandResult {
        let status: Int32
        let stdout: String
        let stderr: String
    }

    struct RemotePlatform: Equatable {
        let os: String
        let arch: String
    }

    private static let safeAliasCharacters = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-@")

    /// Parse SSH config and return available hosts.
    /// Excludes wildcard patterns (*, ?) and localhost.
    static func availableHosts() -> [SSHHost] {
        let configPath = "\(NSHomeDirectory())/.ssh/config"
        guard let content = try? String(contentsOfFile: configPath, encoding: .utf8) else {
            return []
        }
        return parseConfig(content)
    }

    static func parseConfig(_ content: String) -> [SSHHost] {
        var hosts: [SSHHost] = []
        var currentAlias: String?
        var currentHostname: String?
        var currentUser: String?
        var currentPort: Int?
        var currentIdentity: String?

        let flushHost = {
            if let alias = currentAlias,
               !alias.contains("*"), !alias.contains("?"),
               alias.lowercased() != "localhost",
               alias != "0.0.0.0",
               isSafeHostAlias(alias) {
                hosts.append(SSHHost(
                    id: alias,
                    hostname: currentHostname,
                    user: currentUser,
                    port: currentPort,
                    identityFile: currentIdentity
                ))
            }
            currentAlias = nil
            currentHostname = nil
            currentUser = nil
            currentPort = nil
            currentIdentity = nil
        }

        for line in content.components(separatedBy: .newlines) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty || trimmed.hasPrefix("#") { continue }

            let parts = trimmed.split(maxSplits: 1, omittingEmptySubsequences: true, whereSeparator: \.isWhitespace)
                .map(String.init)
            guard parts.count == 2 else { continue }

            let key = parts[0].lowercased()
            let value = parts[1]

            if key == "host" {
                flushHost()
                // Host can have multiple aliases, take the first
                let aliases = value.split(whereSeparator: \.isWhitespace).map(String.init)
                currentAlias = aliases.first
            } else if key == "hostname" {
                currentHostname = value
            } else if key == "user" {
                currentUser = value
            } else if key == "port" {
                currentPort = Int(value)
            } else if key == "identityfile" {
                currentIdentity = value
            }
        }
        flushHost()

        return hosts
    }

    static func configuredHost(named candidate: String, hosts: [SSHHost] = availableHosts()) -> SSHHost? {
        let trimmed = candidate.trimmingCharacters(in: .whitespacesAndNewlines)
        guard isSafeHostAlias(trimmed) else { return nil }
        return hosts.first(where: { $0.id == trimmed })
    }

    static func prepareForAgentConnection(to candidate: String) -> PreparationResult {
        guard let host = configuredHost(named: candidate) else {
            return .failure("ssh.connect only accepts safe aliases from ~/.ssh/config")
        }

        guard let localPlatform = currentPlatform(),
              let remotePlatform = remotePlatform(on: host.id) else {
            return .failure("failed to inspect remote host platform")
        }

        guard let deploymentBinary = RemuxAgent.deploymentBinaryPath(
            for: remotePlatform,
            localPlatform: localPlatform
        ) else {
            return .failure("no bundled remux-agent binary is available for \(remotePlatform.os) \(remotePlatform.arch)")
        }

        guard let mkdir = run(["ssh", host.id, "mkdir -p ~/.remux/bin"]),
              mkdir.status == 0 else {
            return .failure("failed to create ~/.remux/bin on \(host.id)")
        }

        guard let copy = run(["scp", deploymentBinary, "\(host.id):~/.remux/bin/remux-agent"]),
              copy.status == 0 else {
            return .failure("failed to copy remux-agent to \(host.id)")
        }

        guard let chmod = run(["ssh", host.id, "chmod +x ~/.remux/bin/remux-agent"]),
              chmod.status == 0 else {
            return .failure("failed to mark remote remux-agent executable on \(host.id)")
        }

        guard hasRemoteAgent(on: host.id) else {
            return .failure("remote remux-agent verification failed on \(host.id)")
        }

        return .ready(host)
    }

    /// Deploy remux-agent to a remote host via SSH/SCP.
    /// Returns true on success.
    @discardableResult
    static func deployAgent(to host: String) -> Bool {
        prepareForAgentConnection(to: host).isReady
    }

    static func isSafeHostAlias(_ alias: String) -> Bool {
        guard !alias.isEmpty else { return false }
        return alias.rangeOfCharacter(from: safeAliasCharacters.inverted) == nil
    }

    private static func hasRemoteAgent(on host: String) -> Bool {
        guard let result = run(["ssh", host, "~/.remux/bin/remux-agent version"]) else {
            return false
        }
        return result.status == 0 && result.stdout.contains("remux-agent")
    }

    private static func remotePlatform(on host: String) -> RemotePlatform? {
        guard let result = run(["ssh", host, "uname -s && uname -m"]),
              result.status == 0 else {
            return nil
        }
        let lines = result.stdout
            .split(whereSeparator: \.isNewline)
            .map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        guard lines.count >= 2 else { return nil }
        return RemotePlatform(os: lines[0], arch: lines[1])
    }

    private static func currentPlatform() -> RemotePlatform? {
        var systemInfo = utsname()
        guard uname(&systemInfo) == 0 else { return nil }
        let os = decodeUtsField(systemInfo.sysname)
        let arch = decodeUtsField(systemInfo.machine)
        return RemotePlatform(os: os, arch: arch)
    }

    private static func decodeUtsField<T>(_ field: T) -> String {
        var field = field
        return withUnsafeBytes(of: &field) { rawBuffer in
            let buffer = rawBuffer.bindMemory(to: CChar.self)
            guard let baseAddress = buffer.baseAddress else { return "" }
            return String(cString: baseAddress)
        }
    }

    @discardableResult
    private static func run(_ args: [String]) -> CommandResult? {
        guard !args.isEmpty else { return nil }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = args
        let stdout = Pipe()
        let stderr = Pipe()
        process.standardOutput = stdout
        process.standardError = stderr
        do {
            try process.run()
        } catch {
            return nil
        }
        process.waitUntilExit()
        let stdoutText = String(
            data: stdout.fileHandleForReading.readDataToEndOfFile(),
            encoding: .utf8
        ) ?? ""
        let stderrText = String(
            data: stderr.fileHandleForReading.readDataToEndOfFile(),
            encoding: .utf8
        ) ?? ""
        return CommandResult(
            status: process.terminationStatus,
            stdout: stdoutText,
            stderr: stderrText
        )
    }
}
