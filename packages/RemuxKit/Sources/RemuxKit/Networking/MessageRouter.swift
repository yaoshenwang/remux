import Foundation

/// Routes incoming WebSocket messages to the appropriate handler.
/// Supports both envelope format (v:1) and legacy bare messages.
public struct MessageRouter: Sendable {

    /// Parsed message with type info extracted
    public enum RoutedMessage: Sendable {
        case workspaceSnapshot(WorkspaceSnapshot)
        case attached(AttachedPayload)
        case inspectResult(InspectSnapshot)
        case roleChanged(String) // "active" or "observer"
        case deviceList([DeviceInfo])
        case pairResult(PairResultPayload)
        case pushStatus(PushStatusPayload)
        case error(String)
        case unknown(type: String, raw: String)
    }

    public init() {}

    /// Parse and route a raw JSON message string.
    public func route(_ text: String) -> RoutedMessage? {
        guard let data = text.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }

        // Extract type — handle both envelope (v:1) and legacy format
        let msgType: String?
        let payload: [String: Any]?

        if let v = json["v"] as? Int, v >= 1 {
            // Envelope format
            msgType = json["type"] as? String
            payload = json["payload"] as? [String: Any]
        } else {
            // Legacy format — type is top-level
            msgType = json["type"] as? String
            payload = json
        }

        guard let type = msgType else { return nil }

        switch type {
        case "bootstrap":
            if let p = payload, let bootstrap = decode(BootstrapPayload.self, from: p) {
                return .workspaceSnapshot(
                    WorkspaceSnapshot(sessions: bootstrap.sessions, clients: bootstrap.clients)
                )
            }
        case "state":
            if let p = payload {
                if let snapshot = decode(CurrentWorkspaceStatePayload.self, from: p) {
                    return .workspaceSnapshot(
                        WorkspaceSnapshot(sessions: snapshot.sessions, clients: snapshot.clients)
                    )
                }
                if let state = decode(WorkspaceState.self, from: p) {
                    let session = WorkspaceSessionSummary(
                        name: state.session,
                        tabs: state.tabs.map {
                            WorkspaceSessionTab(
                                id: $0.index,
                                title: $0.name,
                                ended: false,
                                clients: 0,
                                restored: false
                            )
                        },
                        createdAt: 0
                    )
                    return .workspaceSnapshot(
                        WorkspaceSnapshot(
                            sessions: [session],
                            clients: [ConnectedClientInfo(
                                clientId: "",
                                role: "active",
                                session: state.session,
                                tabId: state.activeTabIndex
                            )]
                        )
                    )
                }
            }
        case "attached":
            if let p = payload, let attached = decode(AttachedPayload.self, from: p) {
                return .attached(attached)
            }
        case "inspect_result":
            if let p = payload {
                if let snapshot = decode(InspectSnapshot.self, from: p) {
                    return .inspectResult(snapshot)
                }
                if let result = decode(ServerInspectResult.self, from: p) {
                    return .inspectResult(convertInspectResult(result))
                }
            }
        case "role_changed":
            if let role = payload?["role"] as? String {
                return .roleChanged(role)
            }
        case "device_list":
            if let p = payload, let list = decode(DeviceListPayload.self, from: p) {
                return .deviceList(list.devices)
            }
        case "pair_result":
            if let p = payload, let result = decode(PairResultPayload.self, from: p) {
                return .pairResult(result)
            }
        case "push_status":
            if let p = payload, let status = decode(PushStatusPayload.self, from: p) {
                return .pushStatus(status)
            }
        case "error":
            let message = payload?["reason"] as? String
                ?? payload?["message"] as? String
                ?? "Unknown error"
            return .error(message)
        default:
            return .unknown(type: type, raw: text)
        }

        return .unknown(type: type, raw: text)
    }

    private func convertInspectResult(_ result: ServerInspectResult) -> InspectSnapshot {
        let timestamp = ISO8601DateFormatter().string(from: Date(timeIntervalSince1970: TimeInterval(result.meta.timestamp) / 1000))
        let lines = result.text.split(separator: "\n", omittingEmptySubsequences: false)
        let items = lines.enumerated().map { offset, line in
            InspectItem(
                type: "output",
                content: String(line),
                lineNumber: offset + 1,
                timestamp: timestamp,
                paneId: result.meta.tabId.map(String.init),
                highlights: nil
            )
        }

        return InspectSnapshot(
            descriptor: InspectDescriptor(
                scope: "tab",
                source: "server",
                precision: "precise",
                staleness: "fresh",
                capturedAt: timestamp,
                paneId: result.meta.tabId.map(String.init),
                tabIndex: result.meta.tabId,
                totalItems: items.count
            ),
            items: items,
            cursor: nil,
            truncated: false
        )
    }

    private func decode<T: Decodable>(_ type: T.Type, from dict: [String: Any]) -> T? {
        guard let data = try? JSONSerialization.data(withJSONObject: dict) else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }
}

// MARK: - Additional payload types needed by router

public struct DeviceInfo: Codable, Equatable, Sendable {
    public let id: String
    public let fingerprint: String?
    public let name: String?
    public let platform: String?
    public let trust: String
    public let lastSeen: Int?
}

public struct DeviceListPayload: Codable, Equatable, Sendable {
    public let devices: [DeviceInfo]
}

public struct PairResultPayload: Codable, Equatable, Sendable {
    public let success: Bool
    public let deviceId: String?
    public let reason: String?
}

public struct PushStatusPayload: Codable, Equatable, Sendable {
    public let subscribed: Bool
}
