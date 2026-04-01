import SwiftUI
import RemuxKit

@main
struct RemuxiOSApp: App {
    @State private var state = RemuxState()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(state)
        }
    }
}
