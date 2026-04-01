import AppKit
import UniformTypeIdentifiers

/// Helper for enhanced clipboard operations in the terminal.
/// Adapted from ghostty-org/ghostty macOS clipboard handling patterns.
enum ClipboardHelper {

    /// Read paste content from the pasteboard with priority:
    /// file URLs -> plain text -> RTF -> HTML
    static func pasteContent(from pasteboard: NSPasteboard) -> String? {
        // Priority 1: File URLs — paste as escaped shell paths
        if let urls = pasteboard.readObjects(forClasses: [NSURL.self], options: nil) as? [URL],
           !urls.isEmpty {
            let paths = urls.compactMap { url -> String? in
                guard url.isFileURL else { return url.absoluteString }
                return escapeForShell(url.path)
            }
            if !paths.isEmpty {
                return paths.joined(separator: " ")
            }
        }

        // Priority 2: Plain text
        if let text = pasteboard.string(forType: .string), !text.isEmpty {
            return text
        }

        // Priority 3: RTF — extract plain text from attributed string
        if let rtfData = pasteboard.data(forType: .rtf) {
            if let attrStr = NSAttributedString(rtf: rtfData, documentAttributes: nil) {
                let text = attrStr.string
                if !text.isEmpty { return text }
            }
        }

        // Priority 4: HTML — extract plain text from HTML
        if let htmlData = pasteboard.data(forType: .html) {
            if let attrStr = try? NSAttributedString(
                data: htmlData,
                options: [.documentType: NSAttributedString.DocumentType.html],
                documentAttributes: nil
            ) {
                let text = attrStr.string
                if !text.isEmpty { return text }
            }
        }

        return nil
    }

    /// Escape a file path for safe use in shell commands.
    /// Handles spaces, parentheses, quotes, and other special characters.
    static func escapeForShell(_ path: String) -> String {
        let specialChars: Set<Character> = [
            " ", "(", ")", "'", "\"", "\\", "!", "#", "$", "&",
            ";", "|", "<", ">", "?", "*", "[", "]", "{", "}",
            "~", "`", "^",
        ]

        var result = ""
        for char in path {
            if specialChars.contains(char) {
                result.append("\\")
            }
            result.append(char)
        }
        return result
    }

    /// Save a pasted image from the pasteboard to a temp file.
    /// Returns the file URL if successful.
    static func saveImageToTemp(from pasteboard: NSPasteboard) -> URL? {
        // Check for image data types
        let imageTypes: [NSPasteboard.PasteboardType] = [.tiff, .png]

        for imageType in imageTypes {
            guard let imageData = pasteboard.data(forType: imageType) else { continue }

            guard let image = NSImage(data: imageData),
                  let tiffData = image.tiffRepresentation,
                  let bitmap = NSBitmapImageRep(data: tiffData),
                  let pngData = bitmap.representation(using: .png, properties: [:]) else {
                continue
            }

            let tempDir = FileManager.default.temporaryDirectory
            let filename = "remux-paste-\(UUID().uuidString.prefix(8)).png"
            let fileURL = tempDir.appendingPathComponent(filename)

            do {
                try pngData.write(to: fileURL)
                return fileURL
            } catch {
                NSLog("[remux] Failed to save pasted image: \(error)")
                continue
            }
        }

        return nil
    }
}
