import Testing
import Foundation
import Security
@testable import RemuxKit

/// Keychain tests require macOS Keychain access (not available in headless CI).
/// Tests are conditionally enabled.
@Suite("KeychainStore")
struct KeychainStoreTests {

    let store = KeychainStore()
    let testServer = "test-server-\(UUID().uuidString)"

    static var keychainAvailable: Bool {
        // CI environments (GitHub Actions, etc.) have partially-broken Keychain:
        // SecItemAdd may succeed but the real store operations fail with -25299.
        // Skip Keychain tests entirely in CI.
        if ProcessInfo.processInfo.environment["CI"] != nil { return false }

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "com.remux.test-probe",
            kSecAttrAccount as String: UUID().uuidString,
            kSecValueData as String: Data("probe".utf8),
        ]
        let status = SecItemAdd(query as CFDictionary, nil)
        if status == errSecSuccess {
            SecItemDelete(query as CFDictionary)
            return true
        }
        return false
    }

    @Test("Save and load server token", .enabled(if: keychainAvailable))
    func saveAndLoadToken() throws {
        try store.saveServerToken("abc123", forServer: testServer)
        defer { store.deleteServerToken(forServer: testServer) }
        let loaded = store.loadServerToken(forServer: testServer)
        #expect(loaded == "abc123")
    }

    @Test("Save and load resume token", .enabled(if: keychainAvailable))
    func saveAndLoadResumeToken() throws {
        try store.saveResumeToken("resume-xyz", forServer: testServer)
        defer { store.deleteResumeToken(forServer: testServer) }
        let loaded = store.loadResumeToken(forServer: testServer)
        #expect(loaded == "resume-xyz")
    }

    @Test("Load nonexistent key returns nil")
    func loadMissing() {
        let result = store.loadServerToken(forServer: "nonexistent-\(UUID().uuidString)")
        #expect(result == nil)
    }

    @Test("Delete removes key", .enabled(if: keychainAvailable))
    func deleteKey() throws {
        try store.saveServerToken("temp", forServer: testServer)
        store.deleteServerToken(forServer: testServer)
        let loaded = store.loadServerToken(forServer: testServer)
        #expect(loaded == nil)
    }

    @Test("Update existing key", .enabled(if: keychainAvailable))
    func updateKey() throws {
        try store.saveServerToken("v1", forServer: testServer)
        try store.saveServerToken("v2", forServer: testServer)
        defer { store.deleteServerToken(forServer: testServer) }
        let loaded = store.loadServerToken(forServer: testServer)
        #expect(loaded == "v2")
    }

    @Test("Delete all for server", .enabled(if: keychainAvailable))
    func deleteAll() throws {
        try store.saveServerToken("tok", forServer: testServer)
        try store.saveDeviceId("dev", forServer: testServer)
        store.deleteAll(forServer: testServer)
        #expect(store.loadServerToken(forServer: testServer) == nil)
        #expect(store.loadDeviceId(forServer: testServer) == nil)
    }

    @Test("Saved servers include token-only and resume-token-only entries", .enabled(if: keychainAvailable))
    func savedServersIncludesAllCredentialTypes() throws {
        let tokenOnly = "token-only-\(UUID().uuidString)"
        let resumeOnly = "resume-only-\(UUID().uuidString)"
        try store.saveServerToken("tok", forServer: tokenOnly)
        try store.saveResumeToken("resume", forServer: resumeOnly)
        defer {
            store.deleteAll(forServer: tokenOnly)
            store.deleteAll(forServer: resumeOnly)
        }

        let servers = store.savedServers()
        #expect(servers.contains(tokenOnly))
        #expect(servers.contains(resumeOnly))
    }

    @Test("Preferred credential uses server token before resume token", .enabled(if: keychainAvailable))
    func preferredCredentialPrefersServerToken() throws {
        try store.saveServerToken("tok", forServer: testServer)
        try store.saveResumeToken("resume", forServer: testServer)
        defer { store.deleteAll(forServer: testServer) }

        let credential = store.preferredCredential(forServer: testServer)
        #expect(credential == .token("tok"))
    }
}
