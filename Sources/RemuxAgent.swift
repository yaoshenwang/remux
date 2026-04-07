import CryptoKit
import Darwin
import Foundation

/// Manages the local remux-agent daemon for persistent terminal sessions.
enum RemuxAgent {
    /// Locate the remux-agent binary. Checks:
    /// 1. App bundle Resources/bin/
    /// 2. ~/.remux/bin/
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
            ?? defaultSocketPath()
    }

    /// Check if the agent daemon is running (socket exists and is connectable).
    static var isDaemonRunning: Bool {
        isSocketConnectable(at: socketPath)
    }

    /// Start the agent daemon if not already running.
    static func ensureDaemonRunning() {
        guard !isDaemonRunning else { return }
        guard let path = agentPath() else { return }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: path)
        process.arguments = ["serve", "--daemon"]
        process.environment = ProcessInfo.processInfo.environment.merging(
            ["REMUX_AGENT_SOCKET": socketPath],
            uniquingKeysWith: { _, new in new }
        )
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
        return attachCommand(agentPath: path, sessionId: sessionId)
    }

    /// Build the SSH command for attaching to a remote session.
    static func sshAttachCommand(host: String, sessionId: String) -> String? {
        guard let entry = SSHHostManager.configuredHost(named: host) else { return nil }
        return sshAttachCommand(host: entry, sessionId: sessionId)
    }

    /// Generate a new session UUID string (36 chars).
    static func newSessionId() -> String {
        UUID().uuidString.lowercased()
    }

    static func attachCommand(agentPath: String, sessionId: String) -> String {
        attachCommand(agentPath: agentPath, sessionId: sessionId, socketPath: socketPath)
    }

    static func attachCommand(agentPath: String, sessionId: String, socketPath: String) -> String {
        "REMUX_AGENT_SOCKET=\(shellQuoted(socketPath)) \(shellQuoted(agentPath)) attach \(shellQuoted(sessionId))"
    }

    static func sshAttachCommand(host: SSHHost, sessionId: String) -> String {
        let remoteSocket = remoteSocketPath()
        let remoteCommand = "mkdir -p ~/.remux; " +
            "REMUX_AGENT_SOCKET=\(remoteSocket) ~/.remux/bin/remux-agent serve --daemon >/dev/null 2>&1 || true; " +
            "exec REMUX_AGENT_SOCKET=\(remoteSocket) ~/.remux/bin/remux-agent attach \(shellQuoted(sessionId))"
        return "ssh -t \(shellQuoted(host.id)) \(shellQuoted(remoteCommand))"
    }

    static func deploymentBinaryPath(
        for remotePlatform: SSHHostManager.RemotePlatform,
        localPlatform: SSHHostManager.RemotePlatform
    ) -> String? {
        if remotePlatform == localPlatform {
            return agentPath()
        }

        guard let binaryName = deploymentBinaryName(for: remotePlatform) else {
            return nil
        }

        let bundleCandidate = Bundle.main.resourceURL?
            .appendingPathComponent("bin/\(binaryName)").path
        if let bundleCandidate, FileManager.default.isExecutableFile(atPath: bundleCandidate) {
            return bundleCandidate
        }

        let homeCandidate = "\(NSHomeDirectory())/.remux/bin/\(binaryName)"
        if FileManager.default.isExecutableFile(atPath: homeCandidate) {
            return homeCandidate
        }

        return nil
    }

    static func deploymentBinaryName(for remotePlatform: SSHHostManager.RemotePlatform) -> String? {
        switch (remotePlatform.os.lowercased(), remotePlatform.arch.lowercased()) {
        case ("linux", "x86_64"):
            return "remux-agent-linux-x86_64"
        case ("linux", "aarch64"), ("linux", "arm64"):
            return "remux-agent-linux-aarch64"
        default:
            return nil
        }
    }

    private static func shellQuoted(_ value: String) -> String {
        "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    private static func defaultSocketPath() -> String {
        let baseDir = "\(NSHomeDirectory())/Library/Application Support/remux"
        return "\(baseDir)/\(socketFileName())"
    }

    private static func remoteSocketPath() -> String {
        "~/.remux/\(socketFileName())"
    }

    private static func socketFileName() -> String {
        "remux-agent-\(socketSuffix()).sock"
    }

    private static func socketSuffix() -> String {
        let bundleKey = Bundle.main.bundleIdentifier ?? "default"
        let digest = SHA256.hash(data: Data(bundleKey.utf8))
        return digest.prefix(8).map { String(format: "%02x", $0) }.joined()
    }

    private static func isSocketConnectable(at path: String) -> Bool {
        guard !path.isEmpty else { return false }

        var address = sockaddr_un()
        let pathCapacity = MemoryLayout.size(ofValue: address.sun_path)
        let pathBytes = Array(path.utf8)
        guard pathBytes.count < pathCapacity else { return false }

        let descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
        guard descriptor >= 0 else { return false }
        defer { close(descriptor) }

        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.stride)
        address.sun_family = sa_family_t(AF_UNIX)
        withUnsafeMutableBytes(of: &address.sun_path) { rawBuffer in
            rawBuffer.initializeMemory(as: UInt8.self, repeating: 0)
            rawBuffer.copyBytes(from: pathBytes)
        }

        let result = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPointer in
                connect(descriptor, sockaddrPointer, socklen_t(MemoryLayout<sockaddr_un>.stride))
            }
        }
        return result == 0
    }
}
