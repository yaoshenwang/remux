import Foundation
import RemuxKit

/// Detects listening ports from server-reported process info.
/// Displays detected ports in the sidebar and supports opening
/// in the browser panel (localhost:port).
///
/// Adapted from VS Code port forwarding / detection feature.
@MainActor
@Observable
final class PortScanner {

    /// A detected listening port.
    struct DetectedPort: Identifiable, Equatable, Hashable, Sendable {
        var id: Int { port }
        let port: Int
        let processName: String
        let pid: Int?
        let detectedAt: Date

        var localURL: URL? {
            URL(string: "http://localhost:\(port)")
        }
    }

    /// Currently detected ports.
    private(set) var ports: [DetectedPort] = []

    /// Known port patterns (for naming).
    private static let knownPorts: [Int: String] = [
        3000: "Dev Server",
        3001: "Dev Server",
        4200: "Angular",
        5000: "Flask/ASP.NET",
        5173: "Vite",
        5174: "Vite",
        8000: "Django/FastAPI",
        8080: "HTTP Alt",
        8443: "HTTPS Alt",
        8767: "Remux",
        8888: "Jupyter",
        9000: "PHP-FPM",
        9090: "Prometheus",
    ]

    /// Parse terminal output text for port listening patterns.
    /// Common patterns:
    ///   "listening on port 3000"
    ///   "running on http://localhost:8080"
    ///   "server started at :5173"
    ///   "Local:   http://localhost:5173/"
    func parseTerminalOutput(_ text: String) {
        let patterns = [
            // "listening on port NNNN" or "listening at port NNNN"
            "(?:listening|started|running|serving)\\s+(?:on|at)\\s+(?:port\\s+)?(\\d{2,5})",
            // "http://localhost:NNNN" or "http://127.0.0.1:NNNN"
            "https?://(?:localhost|127\\.0\\.0\\.1):(\\d{2,5})",
            // ":NNNN" at word boundary (e.g., "server at :3000")
            "(?:at|on)\\s+:(\\d{2,5})",
        ]

        for pattern in patterns {
            guard let regex = try? NSRegularExpression(pattern: pattern, options: .caseInsensitive) else {
                continue
            }
            let matches = regex.matches(in: text, range: NSRange(text.startIndex..., in: text))
            for match in matches {
                if let range = Range(match.range(at: 1), in: text),
                   let port = Int(text[range]),
                   port >= 1024, port <= 65535 {
                    addPort(port)
                }
            }
        }
    }

    /// Add a detected port if not already tracked.
    func addPort(_ port: Int, processName: String? = nil, pid: Int? = nil) {
        guard !ports.contains(where: { $0.port == port }) else { return }

        let name = processName ?? Self.knownPorts[port] ?? "Port \(port)"
        let detected = DetectedPort(
            port: port,
            processName: name,
            pid: pid,
            detectedAt: Date()
        )
        ports.append(detected)
        ports.sort { $0.port < $1.port }
        NSLog("[remux] Port detected: %d (%@)", port, name)
    }

    /// Remove a port from the tracked list.
    func removePort(_ port: Int) {
        ports.removeAll { $0.port == port }
    }

    /// Clear all detected ports.
    func clearAll() {
        ports.removeAll()
    }

    /// Check if a port is reachable by attempting a TCP connection.
    func isPortReachable(_ port: Int, timeout: TimeInterval = 1.0) -> Bool {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { return false }
        defer { close(fd) }

        // Set non-blocking
        var flags = fcntl(fd, F_GETFL, 0)
        flags |= O_NONBLOCK
        fcntl(fd, F_SETFL, flags)

        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = UInt16(port).bigEndian
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")

        let result = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockPtr in
                connect(fd, sockPtr, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }

        if result == 0 { return true }
        if errno != EINPROGRESS { return false }

        // Wait for connection with timeout
        var fdSet = fd_set()
        __darwin_fd_zero(&fdSet)
        withUnsafeMutablePointer(to: &fdSet) { ptr in
            let rawPtr = UnsafeMutableRawPointer(ptr)
            let offset = Int(fd / 32)
            let bit = Int(fd % 32)
            rawPtr.advanced(by: offset * MemoryLayout<Int32>.size)
                .assumingMemoryBound(to: Int32.self)
                .pointee |= Int32(1 << bit)
        }

        var tv = timeval(tv_sec: Int(timeout), tv_usec: 0)
        let selectResult = select(fd + 1, nil, &fdSet, nil, &tv)
        return selectResult > 0
    }
}

// MARK: - fd_set helpers

private func __darwin_fd_zero(_ set: inout fd_set) {
    withUnsafeMutableBytes(of: &set) { rawBuf in
        rawBuf.initializeMemory(as: UInt8.self, repeating: 0)
    }
}
