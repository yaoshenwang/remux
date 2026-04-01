import SwiftUI

/// Search overlay displayed on top of the terminal surface.
/// Adapted from ghostty-org/ghostty macOS SearchView.swift (design pattern)
struct SurfaceSearchOverlay: View {
    @Binding var isVisible: Bool
    @Binding var searchText: String
    @Binding var totalMatches: Int
    @Binding var selectedMatch: Int

    var onSearch: (String) -> Void
    var onNext: () -> Void
    var onPrevious: () -> Void
    var onClose: () -> Void

    @FocusState private var isFocused: Bool

    var body: some View {
        if isVisible {
            HStack(spacing: 6) {
                // Search text field
                TextField("Find...", text: $searchText)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 200)
                    .focused($isFocused)
                    .onSubmit {
                        if NSApp.currentEvent?.modifierFlags.contains(.shift) == true {
                            onPrevious()
                        } else {
                            onNext()
                        }
                    }
                    .onChange(of: searchText) { _, newValue in
                        onSearch(newValue)
                    }
                    .onExitCommand {
                        closeSearch()
                    }

                // Match indicator
                matchIndicator
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .frame(minWidth: 50)

                // Navigation buttons
                Button(action: onPrevious) {
                    Image(systemName: "chevron.up")
                        .font(.system(size: 11, weight: .medium))
                }
                .buttonStyle(.borderless)
                .help("Previous Match (Shift+Enter)")
                .disabled(totalMatches <= 0)

                Button(action: onNext) {
                    Image(systemName: "chevron.down")
                        .font(.system(size: 11, weight: .medium))
                }
                .buttonStyle(.borderless)
                .help("Next Match (Enter)")
                .disabled(totalMatches <= 0)

                // Close button
                Button(action: closeSearch) {
                    Image(systemName: "xmark")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.borderless)
                .help("Close (Esc)")
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8))
            .overlay(
                RoundedRectangle(cornerRadius: 8)
                    .stroke(Color.primary.opacity(0.1), lineWidth: 1)
            )
            .shadow(color: .black.opacity(0.15), radius: 4, y: 2)
            .padding(.trailing, 12)
            .padding(.top, 8)
            .onAppear {
                isFocused = true
            }
        }
    }

    @ViewBuilder
    private var matchIndicator: some View {
        if searchText.isEmpty {
            Text("")
        } else if totalMatches < 0 {
            // -1 means regex error
            Text("error")
                .foregroundStyle(.red)
        } else if totalMatches == 0 {
            Text("0 results")
        } else {
            let display = selectedMatch >= 0 ? "\(selectedMatch + 1) of \(totalMatches)" : "\(totalMatches) found"
            Text(display)
        }
    }

    private func closeSearch() {
        searchText = ""
        isVisible = false
        onClose()
    }
}
