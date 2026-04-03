// RemuxConnectionHistory: Persists recent remote connections.
// URLs stored in UserDefaults, tokens in Keychain.

import Foundation
import Security

struct RemuxConnectionEntry: Codable, Identifiable, Equatable {
    let id: UUID
    let label: String
    let url: String
    let lastConnected: Date

    init(label: String, url: String) {
        self.id = UUID()
        self.label = label
        self.url = url
        self.lastConnected = Date()
    }
}

final class RemuxConnectionHistory: ObservableObject {

    static let shared = RemuxConnectionHistory()

    @Published var entries: [RemuxConnectionEntry] = []

    private let storageKey = "remux-connection-history"
    private let keychainService = "com.remux.connection-tokens"
    private let maxEntries = 20

    private init() {
        load()
    }

    func add(url: String, token: String, label: String) {
        // Remove existing entry with same URL
        entries.removeAll { $0.url == url }

        let entry = RemuxConnectionEntry(label: label, url: url)
        entries.insert(entry, at: 0)

        // Trim to max
        if entries.count > maxEntries {
            let removed = entries.suffix(from: maxEntries)
            for r in removed { deleteToken(for: r.id) }
            entries = Array(entries.prefix(maxEntries))
        }

        // Store token in Keychain
        saveToken(token, for: entry.id)
        save()
    }

    func remove(id: UUID) {
        entries.removeAll { $0.id == id }
        deleteToken(for: id)
        save()
    }

    func clearAll() {
        for entry in entries {
            deleteToken(for: entry.id)
        }
        entries.removeAll()
        save()
    }

    func entry(matching query: String) -> RemuxConnectionEntry? {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        if let uuid = UUID(uuidString: trimmed),
           let exact = entries.first(where: { $0.id == uuid }) {
            return exact
        }

        if let exactURL = entries.first(where: { $0.url == trimmed }) {
            return exactURL
        }

        if let exactLabel = entries.first(where: { $0.label.caseInsensitiveCompare(trimmed) == .orderedSame }) {
            return exactLabel
        }

        let lowered = trimmed.lowercased()
        return entries.first {
            $0.label.lowercased().contains(lowered) || $0.url.lowercased().contains(lowered)
        }
    }

    func token(for id: UUID) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: id.uuidString,
            kSecReturnData as String: true,
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    func relativeTime(for date: Date) -> String {
        let interval = Date().timeIntervalSince(date)
        if interval < 60 { return "just now" }
        if interval < 3600 { return "\(Int(interval / 60))m ago" }
        if interval < 86400 { return "\(Int(interval / 3600))h ago" }
        return "\(Int(interval / 86400))d ago"
    }

    // MARK: - Persistence

    private func save() {
        guard let data = try? JSONEncoder().encode(entries) else { return }
        UserDefaults.standard.set(data, forKey: storageKey)
    }

    private func load() {
        guard let data = UserDefaults.standard.data(forKey: storageKey),
              let decoded = try? JSONDecoder().decode([RemuxConnectionEntry].self, from: data) else { return }
        entries = decoded
    }

    private func saveToken(_ token: String, for id: UUID) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: id.uuidString,
        ]
        SecItemDelete(query as CFDictionary)
        var add = query
        add[kSecValueData as String] = token.data(using: .utf8)
        SecItemAdd(add as CFDictionary, nil)
    }

    private func deleteToken(for id: UUID) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: id.uuidString,
        ]
        SecItemDelete(query as CFDictionary)
    }
}
