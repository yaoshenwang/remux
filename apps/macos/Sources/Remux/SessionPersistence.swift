import Foundation

// MARK: - Data Models

/// Snapshot of the entire app session for persistence.
struct AppSession: Codable, Sendable {
    var version: Int = 1
    var serverURL: String?
    var windowFrame: CodableRect?
    var splitLayout: SplitNodeSnapshot
    var sidebarCollapsed: Bool

    init(
        serverURL: String? = nil,
        windowFrame: CGRect? = nil,
        splitLayout: SplitNodeSnapshot = .leaf(tabIndex: 0),
        sidebarCollapsed: Bool = false
    ) {
        self.serverURL = serverURL
        self.windowFrame = windowFrame.map { CodableRect(rect: $0) }
        self.splitLayout = splitLayout
        self.sidebarCollapsed = sidebarCollapsed
    }

    var windowCGRect: CGRect? {
        windowFrame?.cgRect
    }
}

/// Codable wrapper for CGRect since CGRect's Codable is not reliable across platforms.
struct CodableRect: Codable, Sendable {
    var x: Double
    var y: Double
    var width: Double
    var height: Double

    init(rect: CGRect) {
        self.x = rect.origin.x
        self.y = rect.origin.y
        self.width = rect.size.width
        self.height = rect.size.height
    }

    var cgRect: CGRect {
        CGRect(x: x, y: y, width: width, height: height)
    }
}

/// Serializable snapshot of the split tree layout.
indirect enum SplitNodeSnapshot: Codable, Sendable, Hashable {
    case leaf(tabIndex: Int)
    case branch(orientation: String, ratio: Double, first: SplitNodeSnapshot, second: SplitNodeSnapshot)

    // Custom Codable implementation for indirect enum
    private enum CodingKeys: String, CodingKey {
        case type, tabIndex, orientation, ratio, first, second
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .leaf(let tabIndex):
            try container.encode("leaf", forKey: .type)
            try container.encode(tabIndex, forKey: .tabIndex)
        case .branch(let orientation, let ratio, let first, let second):
            try container.encode("branch", forKey: .type)
            try container.encode(orientation, forKey: .orientation)
            try container.encode(ratio, forKey: .ratio)
            try container.encode(first, forKey: .first)
            try container.encode(second, forKey: .second)
        }
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)
        switch type {
        case "leaf":
            let tabIndex = try container.decode(Int.self, forKey: .tabIndex)
            self = .leaf(tabIndex: tabIndex)
        case "branch":
            let orientation = try container.decode(String.self, forKey: .orientation)
            let ratio = try container.decode(Double.self, forKey: .ratio)
            let first = try container.decode(SplitNodeSnapshot.self, forKey: .first)
            let second = try container.decode(SplitNodeSnapshot.self, forKey: .second)
            self = .branch(orientation: orientation, ratio: ratio, first: first, second: second)
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .type,
                in: container,
                debugDescription: "Unknown SplitNodeSnapshot type: \(type)"
            )
        }
    }
}

// MARK: - SplitNode <-> Snapshot Conversion

extension SplitNode {
    /// Convert a live SplitNode tree to a serializable snapshot.
    func toSnapshot() -> SplitNodeSnapshot {
        switch self {
        case .leaf(let data):
            return .leaf(tabIndex: data.tabIndex)
        case .branch(let data):
            return .branch(
                orientation: data.orientation.rawValue,
                ratio: Double(data.ratio),
                first: data.first.toSnapshot(),
                second: data.second.toSnapshot()
            )
        }
    }

    /// Reconstruct a SplitNode tree from a snapshot.
    static func fromSnapshot(_ snapshot: SplitNodeSnapshot) -> SplitNode {
        switch snapshot {
        case .leaf(let tabIndex):
            return .leaf(LeafData(tabIndex: tabIndex))
        case .branch(let orientation, let ratio, let first, let second):
            let orient: Orientation = orientation == "horizontal" ? .horizontal : .vertical
            return .branch(BranchData(
                orientation: orient,
                ratio: CGFloat(ratio),
                first: fromSnapshot(first),
                second: fromSnapshot(second)
            ))
        }
    }
}

// MARK: - Persistence Manager

/// Manages reading and writing the app session to disk.
/// File location: ~/Library/Application Support/com.remux/session.json
final class SessionPersistence: @unchecked Sendable {

    static let shared = SessionPersistence()

    private let fileManager = FileManager.default
    nonisolated(unsafe) private var autosaveTimer: Timer?
    nonisolated(unsafe) private var lastSavedHash: Int = 0

    private var sessionDirectory: URL {
        let appSupport = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        return appSupport.appendingPathComponent("com.remux", isDirectory: true)
    }

    private var sessionFilePath: URL {
        sessionDirectory.appendingPathComponent("session.json")
    }

    private init() {}

    // MARK: - Save

    /// Save the app session to disk.
    @MainActor
    func save(_ session: AppSession) {
        do {
            // Ensure directory exists
            try fileManager.createDirectory(at: sessionDirectory, withIntermediateDirectories: true)

            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            let data = try encoder.encode(session)

            // Skip write if unchanged
            let hash = data.hashValue
            if hash == lastSavedHash { return }
            lastSavedHash = hash

            try data.write(to: sessionFilePath, options: .atomic)
            NSLog("[remux] Session saved to %@", sessionFilePath.path)
        } catch {
            NSLog("[remux] Failed to save session: %@", error.localizedDescription)
        }
    }

    // MARK: - Load

    /// Load the app session from disk. Returns nil if no saved session exists.
    @MainActor
    func load() -> AppSession? {
        guard fileManager.fileExists(atPath: sessionFilePath.path) else {
            NSLog("[remux] No saved session found at %@", sessionFilePath.path)
            return nil
        }

        do {
            let data = try Data(contentsOf: sessionFilePath)
            let decoder = JSONDecoder()
            let session = try decoder.decode(AppSession.self, from: data)
            lastSavedHash = data.hashValue
            NSLog("[remux] Session loaded from %@", sessionFilePath.path)
            return session
        } catch {
            NSLog("[remux] Failed to load session: %@", error.localizedDescription)
            return nil
        }
    }

    // MARK: - Autosave

    /// Start the autosave timer. The closure is called every 8 seconds to
    /// get the current session state.
    @MainActor
    func startAutosave(sessionProvider: @escaping @MainActor () -> AppSession) {
        stopAutosave()
        autosaveTimer = Timer.scheduledTimer(withTimeInterval: 8.0, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                let session = sessionProvider()
                self.save(session)
            }
        }
        NSLog("[remux] Autosave started (8s interval)")
    }

    /// Stop the autosave timer.
    @MainActor
    func stopAutosave() {
        autosaveTimer?.invalidate()
        autosaveTimer = nil
    }
}
