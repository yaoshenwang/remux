import SwiftUI
import ServiceManagement

/// Settings window for Remux macOS app.
struct SettingsView: View {
    @AppStorage("theme") private var theme: String = "system"
    @AppStorage("globalShortcut") private var globalShortcut: String = "⌘⇧R"
    @AppStorage("notifyBell") private var notifyBell = true
    @AppStorage("notifyRunComplete") private var notifyRunComplete = true
    @AppStorage("notifyApproval") private var notifyApproval = true
    @AppStorage("launchAtLogin") private var launchAtLogin = false

    var body: some View {
        TabView {
            generalTab
                .tabItem { Label("General", systemImage: "gear") }

            ShortcutSettingsView()
                .tabItem { Label("Shortcuts", systemImage: "keyboard") }

            notificationsTab
                .tabItem { Label("Notifications", systemImage: "bell") }
        }
        .frame(width: 560, height: 440)
        .padding()
    }

    private var generalTab: some View {
        Form {
            Picker("Theme", selection: $theme) {
                Text("System").tag("system")
                Text("Dark").tag("dark")
                Text("Light").tag("light")
            }
            .onChange(of: theme) { _, newValue in
                applyTheme(newValue)
            }

            LabeledContent("Global Shortcut") {
                Text(globalShortcut)
                    .foregroundStyle(.secondary)
            }

            Toggle("Launch at Login", isOn: $launchAtLogin)
                .onChange(of: launchAtLogin) { _, enabled in
                    do {
                        if enabled {
                            try SMAppService.mainApp.register()
                        } else {
                            try SMAppService.mainApp.unregister()
                        }
                    } catch {
                        launchAtLogin = !enabled
                    }
                }
        }
    }

    private var notificationsTab: some View {
        Form {
            Toggle("Terminal Bell", isOn: $notifyBell)
            Toggle("Run Complete", isOn: $notifyRunComplete)
            Toggle("Approval Needed", isOn: $notifyApproval)
        }
    }

    private func applyTheme(_ theme: String) {
        switch theme {
        case "dark":
            NSApp.appearance = NSAppearance(named: .darkAqua)
        case "light":
            NSApp.appearance = NSAppearance(named: .aqua)
        default:
            NSApp.appearance = nil // system
        }
    }
}
