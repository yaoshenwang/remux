import Foundation
import AppKit

/// Detects SSH connection patterns in terminal text.
/// When detected: enables "Upload File" button in toolbar.
/// Upload uses a command sent to the terminal (scp local remote).
///
/// Adapted from Warp SSH detection / Termius file transfer UX.
@MainActor
@Observable
final class SSHDetector {

    /// Detected SSH connection info.
    struct SSHConnection: Identifiable, Equatable, Sendable {
        let id: UUID
        let user: String
        let host: String
        let port: Int?
        let detectedAt: Date

        /// SCP destination prefix, e.g. "user@host:"
        var scpPrefix: String {
            if let port {
                return "-P \(port) \(user)@\(host):"
            }
            return "\(user)@\(host):"
        }

        var displayString: String {
            if let port {
                return "\(user)@\(host):\(port)"
            }
            return "\(user)@\(host)"
        }

        init(user: String, host: String, port: Int? = nil) {
            self.id = UUID()
            self.user = user
            self.host = host
            self.port = port
            self.detectedAt = Date()
        }
    }

    /// Currently detected SSH connections.
    private(set) var connections: [SSHConnection] = []

    /// Whether any SSH connection is active.
    var hasActiveConnection: Bool {
        !connections.isEmpty
    }

    /// The most recent SSH connection.
    var latestConnection: SSHConnection? {
        connections.last
    }

    // MARK: - Detection patterns

    /// SSH command patterns to detect.
    /// Matches: ssh user@host, ssh -p port user@host, ssh host
    private static let sshPatterns: [(pattern: String, userGroup: Int, hostGroup: Int, portGroup: Int?)] = [
        // ssh -p PORT user@host
        ("ssh\\s+-p\\s+(\\d+)\\s+(\\w+)@([\\w\\.-]+)", 2, 3, 1),
        // ssh user@host -p PORT
        ("ssh\\s+(\\w+)@([\\w\\.-]+)\\s+-p\\s+(\\d+)", 1, 2, 3),
        // ssh user@host
        ("ssh\\s+(\\w+)@([\\w\\.-]+)", 1, 2, nil),
    ]

    /// SCP command patterns.
    private static let scpPatterns: [String] = [
        "scp\\s+.*?(\\w+)@([\\w\\.-]+):",
        "scp\\s+-P\\s+(\\d+)\\s+.*?(\\w+)@([\\w\\.-]+):",
    ]

    // MARK: - Parse terminal text

    /// Parse terminal text for SSH connection patterns.
    func parseTerminalOutput(_ text: String) {
        for (pattern, userGroup, hostGroup, portGroup) in Self.sshPatterns {
            guard let regex = try? NSRegularExpression(pattern: pattern) else { continue }
            let matches = regex.matches(in: text, range: NSRange(text.startIndex..., in: text))

            for match in matches {
                guard let userRange = Range(match.range(at: userGroup), in: text),
                      let hostRange = Range(match.range(at: hostGroup), in: text) else {
                    continue
                }

                let user = String(text[userRange])
                let host = String(text[hostRange])

                var port: Int?
                if let pg = portGroup, let portRange = Range(match.range(at: pg), in: text) {
                    port = Int(text[portRange])
                }

                addConnection(user: user, host: host, port: port)
            }
        }
    }

    /// Add a connection if not already tracked.
    private func addConnection(user: String, host: String, port: Int?) {
        let exists = connections.contains { c in
            c.user == user && c.host == host && c.port == port
        }
        guard !exists else { return }

        let conn = SSHConnection(user: user, host: host, port: port)
        connections.append(conn)
        NSLog("[remux] SSH detected: %@", conn.displayString)
    }

    /// Clear all detected connections.
    func clearAll() {
        connections.removeAll()
    }

    /// Remove a specific connection.
    func remove(_ connection: SSHConnection) {
        connections.removeAll { $0.id == connection.id }
    }

    // MARK: - File upload via SCP

    /// Build an SCP command to upload a local file to the remote host.
    /// Returns the command string to be typed into the terminal.
    func buildUploadCommand(localPath: String, remotePath: String = "~", connection: SSHConnection? = nil) -> String? {
        guard let conn = connection ?? latestConnection else { return nil }

        let escapedLocal = localPath.replacingOccurrences(of: " ", with: "\\ ")

        if let port = conn.port {
            return "scp -P \(port) \(escapedLocal) \(conn.user)@\(conn.host):\(remotePath)"
        }
        return "scp \(escapedLocal) \(conn.user)@\(conn.host):\(remotePath)"
    }

    /// Show file picker and return selected file path.
    func pickFileForUpload() -> URL? {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.canChooseFiles = true

        guard panel.runModal() == .OK else { return nil }
        return panel.url
    }
}
