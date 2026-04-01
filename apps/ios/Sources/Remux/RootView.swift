import SwiftUI
import RemuxKit

/// Root view: onboarding → Face ID → main app.
/// iPad uses NavigationSplitView, iPhone uses TabView.
struct RootView: View {
    @Environment(RemuxState.self) private var state
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var isLocked = true
    @State private var faceIdManager = FaceIDManager()
    private let keychain = KeychainStore()

    var body: some View {
        Group {
            if isLocked {
                LockedView { unlock() }
            } else if case .connected = state.connectionStatus {
                adaptiveMainView
            } else if case .reconnecting = state.connectionStatus {
                adaptiveMainView
                    .overlay(ReconnectingBanner())
            } else {
                OnboardingView()
            }
        }
        .onAppear {
            Task { await checkAuth() }
        }
        .onChange(of: state.connectionStatus) { _, newStatus in
            if case .disconnected = newStatus,
               let snapshot = state.inspectSnapshot,
               let server = state.serverURL?.absoluteString {
                Task {
                    await InspectCache.shared.save(
                        snapshot: snapshot, server: server, tabIndex: state.activeTabIndex
                    )
                }
            }
        }
    }

    @ViewBuilder
    private var adaptiveMainView: some View {
        if sizeClass == .regular {
            iPadLayout
        } else {
            MainTabView()
        }
    }

    /// iPad multi-column: sidebar (tabs) + terminal + inspect
    private var iPadLayout: some View {
        NavigationSplitView {
            List {
                Section("Session: \(state.currentSession)") {
                    ForEach(state.tabs, id: \.index) { tab in
                        Button {
                            if let pane = tab.panes.first { state.switchTab(id: pane.id) }
                        } label: {
                            HStack {
                                Image(systemName: tab.active ? "terminal.fill" : "terminal")
                                Text(tab.name)
                                Spacer()
                                if tab.hasBell { Circle().fill(.red).frame(width: 6, height: 6) }
                            }
                        }
                    }
                }
                Section {
                    Button { state.createTab() } label: {
                        Label("New Tab", systemImage: "plus")
                    }
                }
            }
            .navigationTitle("Remux")
        } content: {
            LiveTerminalView()
        } detail: {
            InspectView()
        }
    }

    private func checkAuth() async {
        let authed = await faceIdManager.authenticateIfNeeded()
        isLocked = !authed
        if authed { tryAutoConnect() }
    }

    private func unlock() {
        Task {
            let authed = await faceIdManager.authenticateIfNeeded()
            if authed { isLocked = false; tryAutoConnect() }
        }
    }

    private func tryAutoConnect() {
        let servers = keychain.savedServers()
        if let server = servers.first,
           let token = keychain.loadResumeToken(forServer: server) ?? keychain.loadServerToken(forServer: server),
           let url = URL(string: server) {
            state.connect(url: url, credential: .token(token))
        }
    }
}

struct LockedView: View {
    let onUnlock: () -> Void
    var body: some View {
        VStack(spacing: 20) {
            Image(systemName: "lock.fill").font(.system(size: 48)).foregroundStyle(.secondary)
            Text("Remux is Locked").font(.title2)
            Button("Unlock with Face ID") { onUnlock() }
                .buttonStyle(.borderedProminent)
        }
    }
}

struct ReconnectingBanner: View {
    var body: some View {
        VStack {
            HStack {
                ProgressView().scaleEffect(0.8)
                Text("Reconnecting...").font(.caption).foregroundStyle(.secondary)
            }
            .padding(8).background(.ultraThinMaterial).cornerRadius(8)
            Spacer()
        }
        .padding(.top, 8)
    }
}
