import Foundation
import Security

/// Keychain wrapper for storing remux credentials.
/// Supports multiple servers via kSecAttrAccount differentiation.
public struct KeychainStore: Sendable {

    private static let service = "com.remux.credentials"

    public init() {}

    // MARK: - Resume Token

    public func saveResumeToken(_ token: String, forServer server: String) throws {
        try save(key: "resume_token", value: token, account: server)
    }

    public func loadResumeToken(forServer server: String) -> String? {
        load(key: "resume_token", account: server)
    }

    public func deleteResumeToken(forServer server: String) {
        delete(key: "resume_token", account: server)
    }

    // MARK: - Device ID

    public func saveDeviceId(_ id: String, forServer server: String) throws {
        try save(key: "device_id", value: id, account: server)
    }

    public func loadDeviceId(forServer server: String) -> String? {
        load(key: "device_id", account: server)
    }

    // MARK: - Server Token (manual token auth)

    public func saveServerToken(_ token: String, forServer server: String) throws {
        try save(key: "server_token", value: token, account: server)
    }

    public func loadServerToken(forServer server: String) -> String? {
        load(key: "server_token", account: server)
    }

    public func deleteServerToken(forServer server: String) {
        delete(key: "server_token", account: server)
    }

    // MARK: - Server List

    /// Returns all server URLs that have stored credentials.
    public func savedServers() -> [String] {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.service,
            kSecAttrLabel as String: "resume_token",
            kSecMatchLimit as String: kSecMatchLimitAll,
            kSecReturnAttributes as String: true,
        ]

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let items = result as? [[String: Any]] else {
            return []
        }

        return items.compactMap { $0[kSecAttrAccount as String] as? String }
    }

    /// Delete all credentials for a server.
    public func deleteAll(forServer server: String) {
        delete(key: "resume_token", account: server)
        delete(key: "device_id", account: server)
        delete(key: "server_token", account: server)
    }

    // MARK: - Low-level helpers

    private func save(key: String, value: String, account: String) throws {
        let data = Data(value.utf8)

        // Try update first
        let updateQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.service,
            kSecAttrLabel as String: key,
            kSecAttrAccount as String: account,
        ]
        let updateAttrs: [String: Any] = [
            kSecValueData as String: data,
        ]

        let updateStatus = SecItemUpdate(updateQuery as CFDictionary, updateAttrs as CFDictionary)
        if updateStatus == errSecSuccess { return }

        // Item doesn't exist — add it
        let addQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.service,
            kSecAttrLabel as String: key,
            kSecAttrAccount as String: account,
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
        ]

        let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
        guard addStatus == errSecSuccess else {
            throw KeychainError.saveFailed(status: addStatus)
        }
    }

    private func load(key: String, account: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.service,
            kSecAttrLabel as String: key,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private func delete(key: String, account: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.service,
            kSecAttrLabel as String: key,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }
}

public enum KeychainError: Error {
    case saveFailed(status: OSStatus)
}
