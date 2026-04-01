import Foundation

/// Manages device trust operations via WebSocket messages.
/// All messages use JSONSerialization for safe construction.
@MainActor
public final class DeviceManager {

    private weak var connection: RemuxConnection?

    public init(connection: RemuxConnection) {
        self.connection = connection
    }

    public func listDevices() { sendJSON(["type": "list_devices"]) }
    public func trustDevice(id: String) { sendJSON(["type": "trust_device", "deviceId": id]) }
    public func blockDevice(id: String) { sendJSON(["type": "block_device", "deviceId": id]) }
    public func renameDevice(id: String, name: String) { sendJSON(["type": "rename_device", "deviceId": id, "name": name]) }
    public func revokeDevice(id: String) { sendJSON(["type": "revoke_device", "deviceId": id]) }
    public func generatePairCode() { sendJSON(["type": "generate_pair_code"]) }
    public func pair(code: String) { sendJSON(["type": "pair", "code": code]) }

    private func sendJSON(_ dict: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: dict),
              let str = String(data: data, encoding: .utf8) else { return }
        connection?.sendString(str)
    }
}
