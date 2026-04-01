import SwiftUI
import RemuxKit

@main
struct RemuxApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    var body: some Scene {
        Settings {
            Text("Remux Settings")
        }
    }
}
