import SwiftUI
import RemuxKit

/// Main content view: sidebar + terminal area.
/// Layout ref: cmux ContentView.swift
struct MainContentView: View {
    @Environment(RemuxState.self) private var state

    var body: some View {
        NavigationSplitView {
            SidebarView()
        } detail: {
            if case .connected = state.connectionStatus {
                TerminalContainerView()
            } else {
                ConnectionView()
            }
        }
        .navigationSplitViewColumnWidth(min: 180, ideal: 220, max: 300)
    }
}
