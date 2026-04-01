import Foundation

/// Routes incoming WebSocket messages to the appropriate handler.
/// Supports both envelope format (v:1) and legacy bare messages.
public struct MessageRouter: Sendable {

    /// Parsed message with type info extracted
    public enum RoutedMessage: Sendable {
        case state(WorkspaceState)
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
        case "state":
            if let p = payload, let state = decode(WorkspaceState.self, from: p) {
                return .state(state)
            }
        case "inspect_result":
            if let p = payload, let snapshot = decode(InspectSnapshot.self, from: p) {
                return .inspectResult(snapshot)
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
            let message = payload?["message"] as? String ?? "Unknown error"
            return .error(message)
        default:
            return .unknown(type: type, raw: text)
        }

        return .unknown(type: type, raw: text)
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
    public let trustLevel: String
    public let lastSeen: String?
}

public struct DeviceListPayload: Codable, Equatable, Sendable {
    public let devices: [DeviceInfo]
}

public struct PairResultPayload: Codable, Equatable, Sendable {
    public let success: Bool
    public let deviceId: String?
    public let error: String?
}

public struct PushStatusPayload: Codable, Equatable, Sendable {
    public let subscribed: Bool
}
