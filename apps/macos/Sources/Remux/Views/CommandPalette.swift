import SwiftUI
import AppKit

/// Command entry for the palette. Each command has a display name,
/// optional shortcut string, and an action closure.
struct PaletteCommand: Identifiable {
    let id: String
    let name: String
    let shortcut: String
    let category: String
    let action: @MainActor () -> Void
}

/// Modal command palette overlay triggered by Cmd+Shift+P.
/// Provides fuzzy search over all available commands.
/// Adapted from VS Code / Warp command palette UX pattern.
struct CommandPalette: View {
    @Binding var isPresented: Bool
    let commands: [PaletteCommand]

    @State private var query: String = ""
    @State private var selectedIndex: Int = 0
    @FocusState private var isFocused: Bool

    private var filteredCommands: [PaletteCommand] {
        if query.isEmpty { return commands }
        let q = query.lowercased()
        return commands.filter { cmd in
            fuzzyMatch(query: q, target: cmd.name.lowercased())
        }
    }

    var body: some View {
        if isPresented {
            ZStack {
                // Dismiss backdrop
                Color.black.opacity(0.3)
                    .ignoresSafeArea()
                    .onTapGesture { dismiss() }

                VStack(spacing: 0) {
                    // Search field
                    HStack(spacing: 8) {
                        Image(systemName: "magnifyingglass")
                            .foregroundStyle(.secondary)
                            .font(.system(size: 14))

                        TextField("Type a command...", text: $query)
                            .textFieldStyle(.plain)
                            .font(.system(size: 14))
                            .focused($isFocused)
                            .onSubmit { executeSelected() }
                            .onChange(of: query) { _, _ in
                                selectedIndex = 0
                            }
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)

                    Divider()

                    // Command list
                    ScrollViewReader { proxy in
                        ScrollView {
                            LazyVStack(spacing: 0) {
                                let filtered = filteredCommands
                                ForEach(Array(filtered.enumerated()), id: \.element.id) { idx, cmd in
                                    CommandRow(
                                        command: cmd,
                                        isSelected: idx == selectedIndex
                                    )
                                    .id(idx)
                                    .onTapGesture {
                                        selectedIndex = idx
                                        executeSelected()
                                    }
                                    .onHover { hovering in
                                        if hovering { selectedIndex = idx }
                                    }
                                }

                                if filtered.isEmpty {
                                    Text("No matching commands")
                                        .foregroundStyle(.secondary)
                                        .font(.system(size: 13))
                                        .padding(.vertical, 20)
                                }
                            }
                        }
                        .frame(maxHeight: 300)
                        .onChange(of: selectedIndex) { _, newValue in
                            proxy.scrollTo(newValue, anchor: .center)
                        }
                    }
                }
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 10))
                .overlay(
                    RoundedRectangle(cornerRadius: 10)
                        .stroke(Color.primary.opacity(0.1), lineWidth: 1)
                )
                .shadow(color: .black.opacity(0.25), radius: 20, y: 10)
                .frame(width: 500)
                .frame(maxHeight: 380)
                .offset(y: -80)
            }
            .onAppear {
                query = ""
                selectedIndex = 0
                isFocused = true
            }
            .onKeyPress(.upArrow) {
                moveSelection(by: -1)
                return .handled
            }
            .onKeyPress(.downArrow) {
                moveSelection(by: 1)
                return .handled
            }
            .onKeyPress(.escape) {
                dismiss()
                return .handled
            }
            .onKeyPress(.return) {
                executeSelected()
                return .handled
            }
        }
    }

    private func moveSelection(by delta: Int) {
        let count = filteredCommands.count
        guard count > 0 else { return }
        selectedIndex = (selectedIndex + delta + count) % count
    }

    private func executeSelected() {
        let filtered = filteredCommands
        guard selectedIndex >= 0, selectedIndex < filtered.count else { return }
        let cmd = filtered[selectedIndex]
        dismiss()
        cmd.action()
    }

    private func dismiss() {
        isPresented = false
        query = ""
    }

    /// Simple fuzzy match: all characters in query appear in order in target.
    private func fuzzyMatch(query: String, target: String) -> Bool {
        var targetIdx = target.startIndex
        for qChar in query {
            guard let found = target[targetIdx...].firstIndex(of: qChar) else {
                return false
            }
            targetIdx = target.index(after: found)
        }
        return true
    }
}

/// Single command row in the palette.
struct CommandRow: View {
    let command: PaletteCommand
    let isSelected: Bool

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 1) {
                Text(command.name)
                    .font(.system(size: 13))
                    .foregroundStyle(isSelected ? .primary : .primary)

                Text(command.category)
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
            }

            Spacer()

            if !command.shortcut.isEmpty {
                Text(command.shortcut)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(
                        RoundedRectangle(cornerRadius: 4)
                            .fill(Color.primary.opacity(0.06))
                    )
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 6)
        .background(isSelected ? Color.accentColor.opacity(0.15) : Color.clear)
        .contentShape(Rectangle())
    }
}
