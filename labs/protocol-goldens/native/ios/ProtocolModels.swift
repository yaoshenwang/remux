public struct ProtocolCapabilities: Codable, Equatable {
  public let envelope: Bool
  public let inspectV2: Bool
  public let deviceTrust: Bool
}

public struct AuthPayload: Codable, Equatable {
  public let token: String
  public let password: String?
  public let cols: Int?
  public let rows: Int?
  public let capabilities: ProtocolCapabilities?
}

public struct AuthOkPayload: Codable, Equatable {
  public let capabilities: ProtocolCapabilities
}

public struct AuthErrorPayload: Codable, Equatable {
  public let reason: String
}

public struct InspectContentPayload: Codable, Equatable {
  public let content: String
}

public struct RemuxEnvelope<Payload: Codable & Equatable>: Codable, Equatable {
  public let domain: String
  public let type: String
  public let version: Int
  public let requestId: String?
  public let emittedAt: String
  public let source: String
  public let payload: Payload
}

public struct WorkspacePane: Codable, Equatable {
  public let id: String
  public let focused: Bool
  public let title: String
  public let command: String?
  public let cwd: String?
  public let rows: Int
  public let cols: Int
  public let x: Int
  public let y: Int
}

public struct WorkspaceTab: Codable, Equatable {
  public let index: Int
  public let name: String
  public let active: Bool
  public let isFullscreen: Bool
  public let hasBell: Bool
  public let panes: [WorkspacePane]
}

public struct WorkspaceState: Codable, Equatable {
  public let session: String
  public let tabs: [WorkspaceTab]
  public let activeTabIndex: Int
}

public struct InspectHighlight: Codable, Equatable {
  public let start: Int
  public let end: Int
}

public struct InspectDescriptor: Codable, Equatable {
  public let scope: String
  public let source: String
  public let precision: String
  public let staleness: String
  public let capturedAt: String
  public let paneId: String?
  public let tabIndex: Int?
  public let totalItems: Int?
}

public struct InspectItem: Codable, Equatable {
  public let type: String
  public let content: String
  public let lineNumber: Int?
  public let timestamp: String
  public let paneId: String?
  public let highlights: [InspectHighlight]?
}

public struct InspectSnapshot: Codable, Equatable {
  public let descriptor: InspectDescriptor
  public let items: [InspectItem]
  public let cursor: String?
  public let truncated: Bool
}

public struct InspectRequest: Codable, Equatable {
  public let scope: String
  public let paneId: String?
  public let tabIndex: Int?
  public let cursor: String?
  public let query: String?
  public let limit: Int?
}

public struct BandwidthStats: Codable, Equatable {
  public let rawBytesPerSec: Double
  public let compressedBytesPerSec: Double
  public let savedPercent: Double
  public let fullSnapshotsSent: Int
  public let diffUpdatesSent: Int
  public let avgChangedRowsPerDiff: Double
  public let totalRawBytes: Int
  public let totalCompressedBytes: Int
  public let totalSavedBytes: Int
  public let rttMs: Int?
  public let protocolName: String

  enum CodingKeys: String, CodingKey {
    case rawBytesPerSec
    case compressedBytesPerSec
    case savedPercent
    case fullSnapshotsSent
    case diffUpdatesSent
    case avgChangedRowsPerDiff
    case totalRawBytes
    case totalCompressedBytes
    case totalSavedBytes
    case rttMs
    case protocolName = "protocol"
  }
}

public struct BandwidthStatsPayload: Codable, Equatable {
  public let stats: BandwidthStats
}

public struct LegacyAuthOk: Codable, Equatable {
  public let type: String
  public let capabilities: ProtocolCapabilities
}

public struct LegacyAuth: Codable, Equatable {
  public let type: String
  public let token: String
  public let password: String?
  public let cols: Int?
  public let rows: Int?
  public let capabilities: ProtocolCapabilities?
}

public struct LegacyAuthError: Codable, Equatable {
  public let type: String
  public let reason: String
}

public struct LegacyErrorMessage: Codable, Equatable {
  public let type: String
  public let code: Int?
  public let message: String
}

public struct LegacyPong: Codable, Equatable {
  public let type: String
  public let timestamp: Double
}

public struct LegacyWorkspaceState: Codable, Equatable {
  public let type: String
  public let session: String
  public let tabs: [WorkspaceTab]
  public let activeTabIndex: Int
}

public struct LegacyInspectRequest: Codable, Equatable {
  public let type: String
  public let scope: String
  public let paneId: String?
  public let tabIndex: Int?
  public let cursor: String?
  public let query: String?
  public let limit: Int?
}

public struct LegacyInspectSnapshot: Codable, Equatable {
  public let type: String
  public let descriptor: InspectDescriptor
  public let items: [InspectItem]
  public let cursor: String?
  public let truncated: Bool
}

public struct LegacyBandwidthStats: Codable, Equatable {
  public let type: String
  public let stats: BandwidthStats
}

public struct LegacyInspectContent: Codable, Equatable {
  public let type: String
  public let content: String
}
