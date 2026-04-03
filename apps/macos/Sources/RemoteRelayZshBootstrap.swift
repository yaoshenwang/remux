import Foundation

struct RemoteRelayZshBootstrap {
    let shellStateDir: String

    private var sharedHistoryLines: [String] {
        [
            "if [ -z \"${HISTFILE:-}\" ] || [ \"$HISTFILE\" = \"\(shellStateDir)/.zsh_history\" ]; then export HISTFILE=\"$REMUX_REAL_ZDOTDIR/.zsh_history\"; fi",
        ]
    }

    var zshEnvLines: [String] {
        [
            "[ -f \"$REMUX_REAL_ZDOTDIR/.zshenv\" ] && source \"$REMUX_REAL_ZDOTDIR/.zshenv\"",
            "if [ -n \"${ZDOTDIR:-}\" ] && [ \"$ZDOTDIR\" != \"\(shellStateDir)\" ]; then export REMUX_REAL_ZDOTDIR=\"$ZDOTDIR\"; fi",
        ] + sharedHistoryLines + [
            "export ZDOTDIR=\"\(shellStateDir)\"",
        ]
    }

    var zshProfileLines: [String] {
        [
            "[ -f \"$REMUX_REAL_ZDOTDIR/.zprofile\" ] && source \"$REMUX_REAL_ZDOTDIR/.zprofile\"",
        ]
    }

    func zshRCLines(commonShellLines: [String]) -> [String] {
        sharedHistoryLines + [
            "[ -f \"$REMUX_REAL_ZDOTDIR/.zshrc\" ] && source \"$REMUX_REAL_ZDOTDIR/.zshrc\"",
        ] + commonShellLines
    }

    var zshLoginLines: [String] {
        [
            "[ -f \"$REMUX_REAL_ZDOTDIR/.zlogin\" ] && source \"$REMUX_REAL_ZDOTDIR/.zlogin\"",
        ]
    }
}
