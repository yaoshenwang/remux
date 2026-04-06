import Foundation

/// Parsed SSH host entry from ~/.ssh/config
struct SSHHost: Identifiable, Sendable {
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
               alias != "0.0.0.0" {
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

            let parts = trimmed.split(separator: " ", maxSplits: 1)
                .map { $0.trimmingCharacters(in: .whitespaces) }
            guard parts.count == 2 else { continue }

            let key = parts[0].lowercased()
            let value = parts[1]

            if key == "host" {
                flushHost()
                // Host can have multiple aliases, take the first
                let aliases = value.split(separator: " ").map(String.init)
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

    /// Deploy remux-agent to a remote host via SSH/SCP.
    /// Returns true on success.
    @discardableResult
    static func deployAgent(to host: String) -> Bool {
        guard let localAgent = RemuxAgent.agentPath() else { return false }

        // Detect remote architecture
        let archResult = shell("ssh", host, "uname -m")
        let arch = archResult.trimmingCharacters(in: .whitespacesAndNewlines)

        // Check if agent already exists and is the right version
        let versionResult = shell("ssh", host, "~/.remux/bin/remux-agent version 2>/dev/null || echo MISSING")
        if !versionResult.contains("MISSING") {
            return true // Already deployed
        }

        // Create directory
        _ = shell("ssh", host, "mkdir -p ~/.remux/bin")

        // For now, SCP the local binary (assumes same architecture)
        // TODO: cross-compile for remote arch when different
        _ = shell("scp", localAgent, "\(host):~/.remux/bin/remux-agent")
        _ = shell("ssh", host, "chmod +x ~/.remux/bin/remux-agent")

        // Start daemon
        _ = shell("ssh", host, "~/.remux/bin/remux-agent serve --daemon")

        return true
    }

    private static func shell(_ args: String...) -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = Array(args)
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        try? process.run()
        process.waitUntilExit()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        return String(data: data, encoding: .utf8) ?? ""
    }
}
