import SwiftUI
import RemuxKit

/// Live terminal tab: full-screen ghostty-web terminal via WKWebView.
struct LiveTerminalView: View {
    @Environment(RemuxState.self) private var state
    @State private var bridge: GhosttyBridge?
    @State private var showKeyboardAccessory = true

    var body: some View {
        ZStack {
            // Terminal
            if let bridge {
                GhosttyTerminalView(bridge: bridge)
                    .ignoresSafeArea(.keyboard)
                    .onReceive(NotificationCenter.default.publisher(for: .remuxTerminalData)) { notification in
                        if let data = notification.userInfo?["data"] as? Data {
                            bridge.writeToTerminal(data: data)
                        }
                    }
            }

            // Connection status overlay
            if case .disconnected = state.connectionStatus {
                Color.black.opacity(0.7)
                    .ignoresSafeArea()
                VStack {
                    Image(systemName: "wifi.slash")
                        .font(.largeTitle)
                        .foregroundStyle(.white)
                    Text("Disconnected")
                        .foregroundStyle(.white)
                }
            }
        }
        .safeAreaInset(edge: .bottom) {
            if showKeyboardAccessory {
                TerminalKeyboardAccessory(bridge: bridge)
            }
        }
        .onAppear { setupBridge() }
        .navigationBarHidden(true)
    }

    private func setupBridge() {
        let b = GhosttyBridge()
        b.onInput = { input in
            if let data = input.data(using: .utf8) {
                state.sendTerminalData(data)
            }
        }
        b.onResize = { cols, rows in
            state.sendJSON(["type": "resize", "cols": cols, "rows": rows])
        }
        b.onReady = {
            // Terminal initialized — attach to current tab
        }
        b.onBell = {
            UIImpactFeedbackGenerator(style: .heavy).impactOccurred()
        }
        bridge = b
    }
}

/// Keyboard accessory bar with Esc, Tab, Ctrl, arrows.
/// Design ref: Termius / Blink terminal keyboard accessory.
struct TerminalKeyboardAccessory: View {
    let bridge: GhosttyBridge?
    @State private var ctrlActive = false

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                AccessoryButton("Esc") { send("\u{1b}") }
                AccessoryButton("Tab") { send("\t") }

                AccessoryButton(ctrlActive ? "Ctrl ●" : "Ctrl") {
                    ctrlActive.toggle()
                }

                Divider().frame(height: 20)

                AccessoryButton("↑") { send("\u{1b}[A") }
                AccessoryButton("↓") { send("\u{1b}[B") }
                AccessoryButton("←") { send("\u{1b}[D") }
                AccessoryButton("→") { send("\u{1b}[C") }

                Divider().frame(height: 20)

                AccessoryButton("Ctrl+C") { send("\u{03}") }
                AccessoryButton("Ctrl+D") { send("\u{04}") }
                AccessoryButton("Ctrl+Z") { send("\u{1a}") }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
        }
        .background(.bar)
    }

    private func send(_ text: String) {
        if ctrlActive, text.count == 1, let ascii = text.first?.asciiValue {
            // Ctrl+key: send control character (ascii - 64)
            let ctrl = Character(UnicodeScalar(ascii &- 64))
            bridge?.writeString(String(ctrl))
            ctrlActive = false
        } else {
            bridge?.writeString(text)
        }
    }
}

struct AccessoryButton: View {
    let title: String
    let action: () -> Void

    init(_ title: String, action: @escaping () -> Void) {
        self.title = title
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 13, weight: .medium, design: .monospaced))
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(.quaternary)
                .cornerRadius(6)
        }
        .buttonStyle(.plain)
    }
}
