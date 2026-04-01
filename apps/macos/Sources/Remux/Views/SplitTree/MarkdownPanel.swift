import SwiftUI
import AppKit
import Foundation

/// Markdown file viewer panel for the split pane system.
/// Renders .md files using SwiftUI's AttributedString with markdown parsing.
/// Supports file picker and auto-reload on file change (FSEvents).
///
/// Conforms to PanelProtocol.
/// Adapted from Marked.app / MacDown conceptual design.
@MainActor
final class MarkdownPanel: PanelProtocol {
    let id: UUID
    private(set) var isFocused = false
    private(set) var filePath: URL?
    private(set) var content: String = ""
    private(set) var fileName: String = "Markdown"

    var title: String { fileName }
    var canClose: Bool { true }

    /// Called when the content changes (for view refresh).
    var onContentChange: (() -> Void)?

    /// File system event source for auto-reload.
    nonisolated(unsafe) private var fsEventStream: FSEventStreamRef?

    init(id: UUID = UUID(), filePath: URL? = nil) {
        self.id = id
        if let filePath {
            self.filePath = filePath
            self.fileName = filePath.lastPathComponent
            loadFile(at: filePath)
            watchFile(at: filePath)
        }
    }

    deinit {
        if let stream = fsEventStream {
            FSEventStreamStop(stream)
            FSEventStreamInvalidate(stream)
            FSEventStreamRelease(stream)
        }
    }

    func focus() { isFocused = true }
    func blur() { isFocused = false }

    // MARK: - File operations

    func openFile() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.init(filenameExtension: "md")!]
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false

        panel.begin { [weak self] response in
            guard response == .OK, let url = panel.url else { return }
            Task { @MainActor in
                self?.setFile(url)
            }
        }
    }

    func setFile(_ url: URL) {
        stopWatching()
        filePath = url
        fileName = url.lastPathComponent
        loadFile(at: url)
        watchFile(at: url)
    }

    private func loadFile(at url: URL) {
        do {
            content = try String(contentsOf: url, encoding: .utf8)
            onContentChange?()
        } catch {
            content = "Failed to load file: \(error.localizedDescription)"
            onContentChange?()
        }
    }

    // MARK: - File watching (FSEvents)

    private func watchFile(at url: URL) {
        let dirPath = url.deletingLastPathComponent().path as CFString
        var context = FSEventStreamContext()

        let rawSelf = Unmanaged.passUnretained(self).toOpaque()
        context.info = rawSelf

        let callback: FSEventStreamCallback = { _, info, numEvents, eventPaths, _, _ in
            guard let info else { return }
            let panel = Unmanaged<MarkdownPanel>.fromOpaque(info).takeUnretainedValue()
            let count = numEvents
            _ = count
            Task { @MainActor in
                if let path = panel.filePath {
                    panel.loadFile(at: path)
                }
            }
        }

        var paths = [dirPath] as CFArray
        let stream = FSEventStreamCreate(
            nil,
            callback,
            &context,
            paths,
            FSEventStreamEventId(kFSEventStreamEventIdSinceNow),
            1.0,  // 1 second latency
            FSEventStreamCreateFlags(kFSEventStreamCreateFlagFileEvents | kFSEventStreamCreateFlagUseCFTypes)
        )

        if let stream {
            fsEventStream = stream
            FSEventStreamScheduleWithRunLoop(stream, CFRunLoopGetMain(), CFRunLoopMode.defaultMode.rawValue)
            FSEventStreamStart(stream)
        }
    }

    private func stopWatching() {
        if let stream = fsEventStream {
            FSEventStreamStop(stream)
            FSEventStreamInvalidate(stream)
            FSEventStreamRelease(stream)
            fsEventStream = nil
        }
    }
}

// MARK: - MarkdownPanelView (SwiftUI)

/// SwiftUI view wrapping a MarkdownPanel with toolbar and rendered content.
struct MarkdownPanelView: View {
    @State private var panel: MarkdownPanel
    @State private var refreshID: UUID = UUID()

    init(panel: MarkdownPanel) {
        _panel = State(initialValue: panel)
    }

    var body: some View {
        VStack(spacing: 0) {
            // Toolbar
            HStack(spacing: 8) {
                Image(systemName: "doc.text")
                    .foregroundStyle(.secondary)

                Text(panel.fileName)
                    .font(.system(size: 12, weight: .medium))
                    .lineLimit(1)

                Spacer()

                Button(action: { panel.openFile() }) {
                    Image(systemName: "folder")
                        .font(.system(size: 11))
                }
                .buttonStyle(.borderless)
                .help("Open Markdown File")

                if panel.filePath != nil {
                    Button(action: { reloadContent() }) {
                        Image(systemName: "arrow.clockwise")
                            .font(.system(size: 11))
                    }
                    .buttonStyle(.borderless)
                    .help("Reload")
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(.bar)

            Divider()

            // Content
            if panel.content.isEmpty && panel.filePath == nil {
                ContentUnavailableView(
                    "No File Open",
                    systemImage: "doc.text",
                    description: Text("Click the folder icon to open a Markdown file.")
                )
            } else {
                ScrollView {
                    MarkdownRenderedContent(markdown: panel.content)
                        .padding(16)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .id(refreshID)
                }
            }
        }
        .onAppear {
            panel.onContentChange = {
                refreshID = UUID()
            }
        }
    }

    private func reloadContent() {
        if let path = panel.filePath {
            panel.setFile(path)
            refreshID = UUID()
        }
    }
}

/// Renders markdown text as attributed content using SwiftUI's built-in markdown parser.
struct MarkdownRenderedContent: View {
    let markdown: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            // Split by blank lines to create paragraph blocks
            let blocks = markdown.components(separatedBy: "\n\n")
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                let trimmed = block.trimmingCharacters(in: .whitespacesAndNewlines)
                if trimmed.hasPrefix("# ") {
                    Text(trimmed.dropFirst(2))
                        .font(.title)
                        .fontWeight(.bold)
                        .padding(.top, 8)
                } else if trimmed.hasPrefix("## ") {
                    Text(trimmed.dropFirst(3))
                        .font(.title2)
                        .fontWeight(.semibold)
                        .padding(.top, 6)
                } else if trimmed.hasPrefix("### ") {
                    Text(trimmed.dropFirst(4))
                        .font(.title3)
                        .fontWeight(.medium)
                        .padding(.top, 4)
                } else if trimmed.hasPrefix("```") {
                    // Code block
                    let code = trimmed
                        .replacingOccurrences(of: "```\\w*\n?", with: "", options: .regularExpression)
                        .replacingOccurrences(of: "```", with: "")
                    Text(code)
                        .font(.system(size: 12, design: .monospaced))
                        .padding(10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color.primary.opacity(0.05))
                        .cornerRadius(6)
                } else if trimmed.hasPrefix("- ") || trimmed.hasPrefix("* ") {
                    // List items
                    let items = trimmed.components(separatedBy: "\n")
                    ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                        let cleaned = item
                            .replacingOccurrences(of: "^[\\-\\*]\\s+", with: "", options: .regularExpression)
                        HStack(alignment: .top, spacing: 6) {
                            Text("\u{2022}")
                                .foregroundStyle(.secondary)
                            if let attrStr = try? AttributedString(markdown: cleaned) {
                                Text(attrStr)
                            } else {
                                Text(cleaned)
                            }
                        }
                    }
                } else if trimmed.hasPrefix("---") || trimmed.hasPrefix("***") {
                    Divider()
                        .padding(.vertical, 4)
                } else if !trimmed.isEmpty {
                    // Regular paragraph with inline markdown
                    if let attrStr = try? AttributedString(markdown: trimmed) {
                        Text(attrStr)
                            .textSelection(.enabled)
                    } else {
                        Text(trimmed)
                            .textSelection(.enabled)
                    }
                }
            }
        }
    }
}
