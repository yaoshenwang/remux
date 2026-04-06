import Foundation

/// Manages the local remux-agent daemon for persistent terminal sessions.
enum RemuxAgent {
    /// Locate the remux-agent binary. Checks:
    /// 1. App bundle Resources/bin/
    /// 2. ~/.remux/bin/
    /// 3. PATH (via /usr/bin/which)
    static func agentPath() -> String? {
        // App bundle
        if let bundlePath = Bundle.main.resourceURL?
            .appendingPathComponent("bin/remux-agent").path,
           FileManager.default.isExecutableFile(atPath: bundlePath) {
            return bundlePath
        }

        // ~/.remux/bin/
        let home = NSHomeDirectory()
        let localPath = "\(home)/.remux/bin/remux-agent"
        if FileManager.default.isExecutableFile(atPath: localPath) {
            return localPath
        }

        return nil
    }

    /// The Unix socket path for the local agent daemon.
    static var socketPath: String {
        ProcessInfo.processInfo.environment["REMUX_AGENT_SOCKET"]
            ?? "\(NSHomeDirectory())/.remux/agent.sock"
    }

    /// Check if the agent daemon is running (socket exists and is connectable).
    static var isDaemonRunning: Bool {
        FileManager.default.fileExists(atPath: socketPath)
    }

    /// Start the agent daemon if not already running.
    static func ensureDaemonRunning() {
        guard !isDaemonRunning else { return }
        guard let path = agentPath() else { return }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: path)
        process.arguments = ["serve", "--daemon"]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try? process.run()
        process.waitUntilExit()

        // Give daemon a moment to bind the socket
        usleep(100_000) // 100ms
    }

    /// Build the command string for attaching to a session.
    /// Returns nil if agent is not available.
    static func attachCommand(sessionId: String) -> String? {
        guard let path = agentPath() else { return nil }
        return "\(path) attach \(sessionId)"
    }

    /// Build the SSH command for attaching to a remote session.
    static func sshAttachCommand(host: String, sessionId: String) -> String {
        "ssh -t \(host) ~/.remux/bin/remux-agent attach \(sessionId)"
    }

    /// Generate a new session UUID string (36 chars).
    static func newSessionId() -> String {
        UUID().uuidString.lowercased()
    }
}
