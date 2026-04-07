# vim:ft=zsh
#
# remux ZDOTDIR bootstrap for zsh.
#
# GhosttyKit already uses a ZDOTDIR injection mechanism for zsh (setting ZDOTDIR
# to Ghostty's integration dir). remux also needs to run its integration, but
# we must restore the user's real ZDOTDIR immediately so that:
# - /etc/zshrc sets HISTFILE relative to the real ZDOTDIR/HOME (shared history)
# - zsh loads the user's real .zprofile/.zshrc normally (no wrapper recursion)
#
# We restore ZDOTDIR from (in priority order):
# - GHOSTTY_ZSH_ZDOTDIR (set by GhosttyKit when it overwrote ZDOTDIR)
# - REMUX_ZSH_ZDOTDIR (set by remux when it overwrote a user-provided ZDOTDIR)
# - unset (zsh treats unset ZDOTDIR as $HOME)

if [[ -n "${GHOSTTY_ZSH_ZDOTDIR+X}" ]]; then
    builtin export ZDOTDIR="$GHOSTTY_ZSH_ZDOTDIR"
    builtin unset GHOSTTY_ZSH_ZDOTDIR
elif [[ -n "${REMUX_ZSH_ZDOTDIR+X}" ]]; then
    builtin export ZDOTDIR="$REMUX_ZSH_ZDOTDIR"
    builtin unset REMUX_ZSH_ZDOTDIR
else
    builtin unset ZDOTDIR
fi

{
    # zsh treats unset ZDOTDIR as if it were HOME. We do the same.
    builtin typeset _remux_file="${ZDOTDIR-$HOME}/.zshenv"
    [[ ! -r "$_remux_file" ]] || builtin source -- "$_remux_file"
} always {
    if [[ -o interactive ]]; then
        # We overwrote GhosttyKit's injected ZDOTDIR, so manually load Ghostty's
        # zsh integration if available.
        #
        # We can't rely on GHOSTTY_ZSH_ZDOTDIR here because Ghostty's own zsh
        # bootstrap unsets it before chaining into this remux wrapper.
        if [[ "${REMUX_LOAD_GHOSTTY_ZSH_INTEGRATION:-0}" == "1" && -n "${GHOSTTY_RESOURCES_DIR:-}" ]]; then
            builtin typeset _remux_ghostty="$GHOSTTY_RESOURCES_DIR/shell-integration/zsh/ghostty-integration"
            [[ -r "$_remux_ghostty" ]] && builtin source -- "$_remux_ghostty"
        fi

        # Load remux integration (unless disabled)
        if [[ "${REMUX_SHELL_INTEGRATION:-1}" != "0" && -n "${REMUX_SHELL_INTEGRATION_DIR:-}" ]]; then
            builtin typeset _remux_integ="$REMUX_SHELL_INTEGRATION_DIR/remux-zsh-integration.zsh"
            [[ -r "$_remux_integ" ]] && builtin source -- "$_remux_integ"
        fi
    fi

    builtin unset _remux_file _remux_ghostty _remux_integ
}
