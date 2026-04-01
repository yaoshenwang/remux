import AppKit
import Foundation

/// Lightweight crash reporter: saves crash info to disk and offers to
/// copy the report on next launch. No external SDK dependency.
///
/// Crash files: ~/Library/Application Support/com.remux/crashes/
///
/// Adapted from PLCrashReporter conceptual design (without the framework).
final class CrashReporter: @unchecked Sendable {

    static let shared = CrashReporter()

    private let fileManager = FileManager.default

    private var crashDirectory: URL {
        let appSupport = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        return appSupport
            .appendingPathComponent("com.remux", isDirectory: true)
            .appendingPathComponent("crashes", isDirectory: true)
    }

    private init() {}

    // MARK: - Install handler

    /// Install the uncaught exception handler. Call once at app launch.
    func install() {
        // Ensure crash directory exists
        try? fileManager.createDirectory(at: crashDirectory, withIntermediateDirectories: true)

        NSSetUncaughtExceptionHandler { exception in
            CrashReporter.shared.handleException(exception)
        }

        // Also handle POSIX signals for non-exception crashes
        for sig: Int32 in [SIGABRT, SIGBUS, SIGSEGV, SIGFPE, SIGILL, SIGTRAP] {
            signal(sig) { signalNumber in
                CrashReporter.shared.handleSignal(signalNumber)
            }
        }

        NSLog("[remux] CrashReporter installed")
    }

    // MARK: - Check for previous crash

    /// Check if there are unsent crash reports from a previous launch.
    /// If found, shows an alert offering to copy the report.
    @MainActor
    func checkForPendingReports() {
        let reports = pendingReports()
        guard let latest = reports.last else { return }

        guard let content = try? String(contentsOf: latest, encoding: .utf8) else { return }

        let alert = NSAlert()
        alert.messageText = "Remux Crash Report"
        alert.informativeText = "Remux crashed during the last session. Would you like to copy the crash report to your clipboard?"
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Copy to Clipboard")
        alert.addButton(withTitle: "Dismiss")
        alert.addButton(withTitle: "Delete All Reports")

        let response = alert.runModal()

        switch response {
        case .alertFirstButtonReturn:
            // Copy to clipboard
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(content, forType: .string)
            NSLog("[remux] Crash report copied to clipboard")
            // Mark as sent by renaming
            let sentURL = latest.deletingPathExtension().appendingPathExtension("sent")
            try? fileManager.moveItem(at: latest, to: sentURL)

        case .alertThirdButtonReturn:
            // Delete all reports
            deleteAllReports()

        default:
            // Dismiss: rename to .dismissed so we don't ask again
            let dismissedURL = latest.deletingPathExtension().appendingPathExtension("dismissed")
            try? fileManager.moveItem(at: latest, to: dismissedURL)
        }
    }

    // MARK: - Report listing

    /// List pending (unsent) crash report files.
    func pendingReports() -> [URL] {
        guard let files = try? fileManager.contentsOfDirectory(
            at: crashDirectory,
            includingPropertiesForKeys: [.creationDateKey],
            options: .skipsHiddenFiles
        ) else { return [] }

        return files
            .filter { $0.pathExtension == "crash" }
            .sorted { a, b in
                let aDate = (try? a.resourceValues(forKeys: [.creationDateKey]).creationDate) ?? .distantPast
                let bDate = (try? b.resourceValues(forKeys: [.creationDateKey]).creationDate) ?? .distantPast
                return aDate < bDate
            }
    }

    /// Delete all crash report files.
    func deleteAllReports() {
        guard let files = try? fileManager.contentsOfDirectory(
            at: crashDirectory,
            includingPropertiesForKeys: nil,
            options: .skipsHiddenFiles
        ) else { return }

        for file in files {
            try? fileManager.removeItem(at: file)
        }
        NSLog("[remux] All crash reports deleted")
    }

    // MARK: - Crash handling (called from signal/exception handler)

    private func handleException(_ exception: NSException) {
        let report = buildReport(
            kind: "NSException",
            name: exception.name.rawValue,
            reason: exception.reason ?? "Unknown",
            stackTrace: exception.callStackSymbols
        )
        writeReport(report)
    }

    private func handleSignal(_ signal: Int32) {
        let signalName: String
        switch signal {
        case SIGABRT: signalName = "SIGABRT"
        case SIGBUS:  signalName = "SIGBUS"
        case SIGSEGV: signalName = "SIGSEGV"
        case SIGFPE:  signalName = "SIGFPE"
        case SIGILL:  signalName = "SIGILL"
        case SIGTRAP: signalName = "SIGTRAP"
        default:      signalName = "SIG\(signal)"
        }

        // Capture call stack (limited in signal context)
        var symbols: [String] = []
        var callstack = [UnsafeMutableRawPointer?](repeating: nil, count: 128)
        let frames = backtrace(&callstack, Int32(callstack.count))
        if frames > 0 {
            if let strs = backtrace_symbols(&callstack, frames) {
                for i in 0..<Int(frames) {
                    if let sym = strs[i] {
                        symbols.append(String(cString: sym))
                    }
                }
                free(strs)
            }
        }

        let report = buildReport(
            kind: "Signal",
            name: signalName,
            reason: "Process received \(signalName)",
            stackTrace: symbols
        )
        writeReport(report)

        // Re-raise the signal to get the default behavior (crash)
        Darwin.signal(signal, SIG_DFL)
        raise(signal)
    }

    private func buildReport(kind: String, name: String, reason: String, stackTrace: [String]) -> String {
        let date = ISO8601DateFormatter().string(from: Date())
        // Read version from bundle directly (safe from any context)
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
            ?? ProcessInfo.processInfo.environment["REMUX_VERSION"]
            ?? "0.0.0"
        let os = ProcessInfo.processInfo.operatingSystemVersionString

        var lines = [
            "Remux Crash Report",
            "==================",
            "Date: \(date)",
            "Version: \(version)",
            "OS: macOS \(os)",
            "Type: \(kind)",
            "Name: \(name)",
            "Reason: \(reason)",
            "",
            "Stack Trace:",
            "------------",
        ]
        lines.append(contentsOf: stackTrace)

        return lines.joined(separator: "\n")
    }

    private func writeReport(_ report: String) {
        let timestamp = ISO8601DateFormatter().string(from: Date())
            .replacingOccurrences(of: ":", with: "-")
        let filename = "crash-\(timestamp).crash"
        let fileURL = crashDirectory.appendingPathComponent(filename)

        try? report.write(to: fileURL, atomically: true, encoding: .utf8)

        // Also write to stderr for debugging
        fputs("[remux] Crash report saved: \(fileURL.path)\n", stderr)
    }
}
