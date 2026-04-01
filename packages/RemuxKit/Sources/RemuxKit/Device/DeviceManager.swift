import Foundation

/// Manages device trust operations via WebSocket messages.
@MainActor
public final class DeviceManager {

    private weak var connection: RemuxConnection?

    public init(connection: RemuxConnection) {
        self.connection = connection
    }

    public func listDevices() {
        connection?.sendString("{\"type\":\"list_devices\"}")
    }

    public func trustDevice(id: String) {
        connection?.sendString("{\"type\":\"trust_device\",\"deviceId\":\"\(id)\"}")
    }

    public func blockDevice(id: String) {
        connection?.sendString("{\"type\":\"block_device\",\"deviceId\":\"\(id)\"}")
    }

    public func renameDevice(id: String, name: String) {
        let escaped = name.replacingOccurrences(of: "\"", with: "\\\"")
        connection?.sendString("{\"type\":\"rename_device\",\"deviceId\":\"\(id)\",\"name\":\"\(escaped)\"}")
    }

    public func revokeDevice(id: String) {
        connection?.sendString("{\"type\":\"revoke_device\",\"deviceId\":\"\(id)\"}")
    }

    public func generatePairCode() {
        connection?.sendString("{\"type\":\"generate_pair_code\"}")
    }

    public func pair(code: String) {
        let escaped = code.replacingOccurrences(of: "\"", with: "\\\"")
        connection?.sendString("{\"type\":\"pair\",\"code\":\"\(escaped)\"}")
    }
}
