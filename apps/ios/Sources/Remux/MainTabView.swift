import SwiftUI
import RemuxKit

/// Main 5-tab navigation: Now / Inspect / Live / Control / Me
struct MainTabView: View {
    @Environment(RemuxState.self) private var state
    @State private var selectedTab = 0

    var body: some View {
        TabView(selection: $selectedTab) {
            NowView()
                .tabItem { Label("Now", systemImage: "house.fill") }
                .tag(0)

            InspectView()
                .tabItem { Label("Inspect", systemImage: "doc.text.magnifyingglass") }
                .tag(1)

            LiveTerminalView()
                .tabItem { Label("Live", systemImage: "terminal.fill") }
                .tag(2)

            ControlView()
                .tabItem { Label("Control", systemImage: "slider.horizontal.3") }
                .tag(3)

            MeView()
                .tabItem { Label("Me", systemImage: "person.fill") }
                .tag(4)
        }
    }
}
