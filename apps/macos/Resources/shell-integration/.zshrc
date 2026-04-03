# vim:ft=zsh
#
# Compatibility shim: with the current integration model, remux restores
# ZDOTDIR in .zshenv so this file should never be reached. If it is, restore
# ZDOTDIR and behave like vanilla zsh by sourcing the user's .zshrc.

if [[ -n "${GHOSTTY_ZSH_ZDOTDIR+X}" ]]; then
    builtin export ZDOTDIR="$GHOSTTY_ZSH_ZDOTDIR"
    builtin unset GHOSTTY_ZSH_ZDOTDIR
elif [[ -n "${REMUX_ZSH_ZDOTDIR+X}" ]]; then
    builtin export ZDOTDIR="$REMUX_ZSH_ZDOTDIR"
    builtin unset REMUX_ZSH_ZDOTDIR
else
    builtin unset ZDOTDIR
fi

builtin typeset _remux_file="${ZDOTDIR-$HOME}/.zshrc"
[[ ! -r "$_remux_file" ]] || builtin source -- "$_remux_file"
builtin unset _remux_file
