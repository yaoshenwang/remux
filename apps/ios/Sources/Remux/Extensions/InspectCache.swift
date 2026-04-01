import Foundation
import RemuxKit

/// Offline Inspect cache using file-based storage.
/// Caches up to 50MB of recent Inspect snapshots, LRU eviction.
actor InspectCache {
    static let shared = InspectCache()

    private let cacheDir: URL
    private let maxSize: Int = 50 * 1024 * 1024 // 50MB

    private init() {
        let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
        cacheDir = base.appendingPathComponent("remux-inspect-cache", isDirectory: true)
        try? FileManager.default.createDirectory(at: cacheDir, withIntermediateDirectories: true)
    }

    func save(snapshot: InspectSnapshot, server: String, tabIndex: Int) {
        let key = cacheKey(server: server, tabIndex: tabIndex)
        let entry = CacheEntry(snapshot: snapshot, cachedAt: Date())
        guard let data = try? JSONEncoder().encode(entry) else { return }
        let file = cacheDir.appendingPathComponent(key)
        try? data.write(to: file)
        evictIfNeeded()
    }

    func load(server: String, tabIndex: Int) -> InspectSnapshot? {
        let key = cacheKey(server: server, tabIndex: tabIndex)
        let file = cacheDir.appendingPathComponent(key)
        guard let data = try? Data(contentsOf: file),
              let entry = try? JSONDecoder().decode(CacheEntry.self, from: data) else { return nil }
        return entry.snapshot
    }

    private func cacheKey(server: String, tabIndex: Int) -> String {
        let sanitized = server.replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: ":", with: "_")
        return "\(sanitized)_tab\(tabIndex).json"
    }

    private func evictIfNeeded() {
        guard let files = try? FileManager.default.contentsOfDirectory(
            at: cacheDir, includingPropertiesForKeys: [.fileSizeKey, .contentModificationDateKey]
        ) else { return }

        var totalSize = 0
        var sorted = files.compactMap { url -> (URL, Int, Date)? in
            guard let vals = try? url.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey]),
                  let size = vals.fileSize,
                  let date = vals.contentModificationDate else { return nil }
            totalSize += size
            return (url, size, date)
        }.sorted { $0.2 < $1.2 } // oldest first

        while totalSize > maxSize, !sorted.isEmpty {
            let oldest = sorted.removeFirst()
            try? FileManager.default.removeItem(at: oldest.0)
            totalSize -= oldest.1
        }
    }
}

private struct CacheEntry: Codable {
    let snapshot: InspectSnapshot
    let cachedAt: Date
}
