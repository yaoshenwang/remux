import AppKit

/// Reads and parses the user's Ghostty configuration file.
/// Ghostty config format: key = value, # comments, one setting per line.
/// Ref: ghostty-org/ghostty config file specification.
@MainActor
final class GhosttyConfig: Sendable {

    // MARK: - Parsed values

    let fontFamily: String?
    let fontSize: CGFloat?
    let theme: String?
    let background: NSColor?
    let foreground: NSColor?
    let cursorColor: NSColor?
    let selectionBackground: NSColor?
    let selectionForeground: NSColor?
    let backgroundOpacity: CGFloat?
    let palette: [Int: NSColor]  // ANSI palette 0-15

    // MARK: - Cache

    private static var cachedLight: GhosttyConfig?
    private static var cachedDark: GhosttyConfig?

    // MARK: - Standard config paths

    /// Default user config path.
    static let userConfigPath: String = {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return home + "/.config/ghostty/config"
    }()

    /// Directories to search for themes.
    static let themeSearchPaths: [String] = {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return [
            home + "/.config/ghostty/themes",
            "/usr/share/ghostty/themes",
            "/usr/local/share/ghostty/themes",
        ]
    }()

    // MARK: - Init (private; use load())

    private init(values: [String: String]) {
        fontFamily = values["font-family"]
        fontSize = values["font-size"].flatMap { CGFloat(Double($0) ?? 0) }
        theme = values["theme"]
        background = values["background"].flatMap { Self.parseColor($0) }
        foreground = values["foreground"].flatMap { Self.parseColor($0) }
        cursorColor = values["cursor-color"].flatMap { Self.parseColor($0) }
        selectionBackground = values["selection-background"].flatMap { Self.parseColor($0) }
        selectionForeground = values["selection-foreground"].flatMap { Self.parseColor($0) }

        if let opStr = values["background-opacity"], let op = Double(opStr) {
            backgroundOpacity = CGFloat(max(0, min(1, op)))
        } else {
            backgroundOpacity = nil
        }

        var pal: [Int: NSColor] = [:]
        for i in 0...15 {
            let key = "palette = \(i)"  // ghostty uses "palette = N=RRGGBB" format
            // Actually ghostty uses "palette = 0=#RRGGBB" in a single key
            // But the parsed format from our parser will be "palette" with value "N=#RRGGBB"
            // We handle palette entries specially below
            _ = key
        }

        // Parse palette entries from the raw values (handled in parsePalette)
        pal = [:]  // Will be filled by load() using paletteEntries
        palette = pal
    }

    private init(
        fontFamily: String?,
        fontSize: CGFloat?,
        theme: String?,
        background: NSColor?,
        foreground: NSColor?,
        cursorColor: NSColor?,
        selectionBackground: NSColor?,
        selectionForeground: NSColor?,
        backgroundOpacity: CGFloat?,
        palette: [Int: NSColor]
    ) {
        self.fontFamily = fontFamily
        self.fontSize = fontSize
        self.theme = theme
        self.background = background
        self.foreground = foreground
        self.cursorColor = cursorColor
        self.selectionBackground = selectionBackground
        self.selectionForeground = selectionForeground
        self.backgroundOpacity = backgroundOpacity
        self.palette = palette
    }

    // MARK: - Public API

    /// Load the Ghostty configuration. Caches per color scheme.
    static func load(forScheme scheme: ColorScheme = .current) -> GhosttyConfig {
        switch scheme {
        case .dark:
            if let cached = cachedDark { return cached }
        case .light:
            if let cached = cachedLight { return cached }
        }

        let config = parseConfigFile(at: userConfigPath, scheme: scheme)

        switch scheme {
        case .dark:  cachedDark = config
        case .light: cachedLight = config
        }

        return config
    }

    /// Invalidate the cache (e.g., after detecting config file change).
    static func invalidateCache() {
        cachedLight = nil
        cachedDark = nil
    }

    enum ColorScheme {
        case light, dark

        static var current: ColorScheme {
            let appearance = NSApp.effectiveAppearance
            if appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua {
                return .dark
            }
            return .light
        }
    }

    // MARK: - Parsing

    /// Parse a Ghostty config file into a GhosttyConfig instance.
    private static func parseConfigFile(at path: String, scheme: ColorScheme) -> GhosttyConfig {
        var values: [String: String] = [:]
        var paletteEntries: [Int: NSColor] = [:]

        // Parse main config file
        if let lines = readConfigLines(at: path) {
            parseLines(lines, into: &values, palette: &paletteEntries)
        }

        // If a theme is specified, load theme overrides
        if let themeName = values["theme"] {
            let themeValues = loadTheme(name: themeName, scheme: scheme)
            // Theme values are overridden by user config, so merge theme first
            var merged = themeValues.values
            for (k, v) in values {
                merged[k] = v
            }
            for (k, v) in themeValues.palette {
                if paletteEntries[k] == nil {
                    paletteEntries[k] = v
                }
            }
            values = merged
        }

        return GhosttyConfig(
            fontFamily: values["font-family"],
            fontSize: values["font-size"].flatMap { CGFloat(Double($0) ?? 0) },
            theme: values["theme"],
            background: values["background"].flatMap { parseColor($0) },
            foreground: values["foreground"].flatMap { parseColor($0) },
            cursorColor: values["cursor-color"].flatMap { parseColor($0) },
            selectionBackground: values["selection-background"].flatMap { parseColor($0) },
            selectionForeground: values["selection-foreground"].flatMap { parseColor($0) },
            backgroundOpacity: values["background-opacity"].flatMap { Double($0) }.map { CGFloat(max(0, min(1, $0))) },
            palette: paletteEntries
        )
    }

    /// Read a config file and return its lines, skipping comments and empty lines.
    private static func readConfigLines(at path: String) -> [String]? {
        guard FileManager.default.fileExists(atPath: path),
              let content = try? String(contentsOfFile: path, encoding: .utf8) else {
            return nil
        }
        return content.components(separatedBy: .newlines)
    }

    /// Parse config lines into key-value pairs and palette entries.
    private static func parseLines(
        _ lines: [String],
        into values: inout [String: String],
        palette: inout [Int: NSColor]
    ) {
        for rawLine in lines {
            let line = rawLine.trimmingCharacters(in: .whitespaces)

            // Skip comments and empty lines
            if line.isEmpty || line.hasPrefix("#") { continue }

            // Split on first "=" sign
            guard let eqIndex = line.firstIndex(of: "=") else { continue }
            let key = String(line[line.startIndex..<eqIndex]).trimmingCharacters(in: .whitespaces)
            let value = String(line[line.index(after: eqIndex)...]).trimmingCharacters(in: .whitespaces)

            if key.isEmpty { continue }

            // Handle palette entries: "palette = 0=#000000" or just key "palette" with value "0=#000000"
            if key == "palette" {
                if let parsed = parsePaletteEntry(value) {
                    palette[parsed.index] = parsed.color
                }
                continue
            }

            values[key] = value
        }
    }

    /// Parse a palette value like "0=#000000" into (index, color).
    private static func parsePaletteEntry(_ value: String) -> (index: Int, color: NSColor)? {
        // Format: "N=RRGGBB" or "N=#RRGGBB"
        guard let eqIdx = value.firstIndex(of: "=") else { return nil }
        let indexStr = String(value[value.startIndex..<eqIdx]).trimmingCharacters(in: .whitespaces)
        let colorStr = String(value[value.index(after: eqIdx)...]).trimmingCharacters(in: .whitespaces)

        guard let index = Int(indexStr), (0...15).contains(index) else { return nil }
        guard let color = parseColor(colorStr) else { return nil }
        return (index, color)
    }

    /// Theme file result container.
    private struct ThemeResult {
        var values: [String: String] = [:]
        var palette: [Int: NSColor] = [:]
    }

    /// Load a theme by name from standard search paths.
    private static func loadTheme(name: String, scheme: ColorScheme) -> ThemeResult {
        // Ghostty supports "theme = auto" which picks light/dark variant
        var themeName = name
        if themeName == "auto" {
            // No specific theme to load for "auto"
            return ThemeResult()
        }

        // Search theme files
        for searchPath in themeSearchPaths {
            let themePath = searchPath + "/" + themeName
            if let lines = readConfigLines(at: themePath) {
                var result = ThemeResult()
                parseLines(lines, into: &result.values, palette: &result.palette)
                return result
            }
        }

        // Also check with common extensions
        for ext in ["", ".conf", ".theme"] {
            for searchPath in themeSearchPaths {
                let themePath = searchPath + "/" + themeName + ext
                if let lines = readConfigLines(at: themePath) {
                    var result = ThemeResult()
                    parseLines(lines, into: &result.values, palette: &result.palette)
                    return result
                }
            }
        }

        return ThemeResult()
    }

    // MARK: - Color parsing

    /// Parse a hex color string to NSColor.
    /// Supports: "#RRGGBB", "RRGGBB", "#RGB", "RGB", "#RRGGBBAA"
    static func parseColor(_ str: String) -> NSColor? {
        var hex = str.trimmingCharacters(in: .whitespaces)
        if hex.hasPrefix("#") {
            hex = String(hex.dropFirst())
        }

        // Expand shorthand #RGB to #RRGGBB
        if hex.count == 3 {
            let chars = Array(hex)
            hex = String([chars[0], chars[0], chars[1], chars[1], chars[2], chars[2]])
        }

        let scanner = Scanner(string: hex)
        var value: UInt64 = 0
        guard scanner.scanHexInt64(&value) else { return nil }

        if hex.count == 8 {
            // RRGGBBAA
            let r = CGFloat((value >> 24) & 0xFF) / 255.0
            let g = CGFloat((value >> 16) & 0xFF) / 255.0
            let b = CGFloat((value >> 8) & 0xFF) / 255.0
            let a = CGFloat(value & 0xFF) / 255.0
            return NSColor(srgbRed: r, green: g, blue: b, alpha: a)
        } else if hex.count == 6 {
            // RRGGBB
            let r = CGFloat((value >> 16) & 0xFF) / 255.0
            let g = CGFloat((value >> 8) & 0xFF) / 255.0
            let b = CGFloat(value & 0xFF) / 255.0
            return NSColor(srgbRed: r, green: g, blue: b, alpha: 1.0)
        }

        return nil
    }
}
