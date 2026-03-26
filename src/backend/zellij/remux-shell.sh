#!/bin/sh

export REMUX=1

target_shell="${REMUX_ORIGINAL_SHELL:-${SHELL:-/bin/sh}}"
if [ ! -x "$target_shell" ]; then
  target_shell="$(command -v sh)"
fi

exec "$target_shell" "$@"
