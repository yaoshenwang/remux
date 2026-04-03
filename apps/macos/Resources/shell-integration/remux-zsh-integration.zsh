# remux shell integration for zsh
# Injected automatically — do not source manually

# Prefer zsh/net/unix for socket sends (no fork, ~0.2ms per send vs ~3ms
# for fork+exec of ncat/socat/nc).  Falls back to external tools if the
# module is unavailable.
typeset -g _REMUX_HAS_ZSOCKET=0
if zmodload zsh/net/unix 2>/dev/null; then
    _REMUX_HAS_ZSOCKET=1
fi

_remux_send() {
    local payload="$1"
    if (( _REMUX_HAS_ZSOCKET )); then
        local fd
        zsocket "$REMUX_SOCKET_PATH" 2>/dev/null || return 1
        fd=$REPLY
        print -u $fd -r -- "$payload" 2>/dev/null
        exec {fd}>&- 2>/dev/null
        return 0
    fi
    if command -v ncat >/dev/null 2>&1; then
        print -r -- "$payload" | ncat -w 1 -U "$REMUX_SOCKET_PATH" --send-only
    elif command -v socat >/dev/null 2>&1; then
        print -r -- "$payload" | socat -T 1 - "UNIX-CONNECT:$REMUX_SOCKET_PATH" >/dev/null 2>&1
    elif command -v nc >/dev/null 2>&1; then
        if print -r -- "$payload" | nc -N -U "$REMUX_SOCKET_PATH" >/dev/null 2>&1; then
            :
        else
            print -r -- "$payload" | nc -w 1 -U "$REMUX_SOCKET_PATH" >/dev/null 2>&1 || true
        fi
    fi
}

# Fire-and-forget send: synchronous when zsocket is available (fast, no fork),
# backgrounded otherwise.
_remux_send_bg() {
    if (( _REMUX_HAS_ZSOCKET )); then
        _remux_send "$1"
    else
        { _remux_send "$1" } >/dev/null 2>&1 &!
    fi
}

_remux_restore_scrollback_once() {
    local path="${REMUX_RESTORE_SCROLLBACK_FILE:-}"
    [[ -n "$path" ]] || return 0
    unset REMUX_RESTORE_SCROLLBACK_FILE

    if [[ -r "$path" ]]; then
        /bin/cat -- "$path" 2>/dev/null || true
        /bin/rm -f -- "$path" >/dev/null 2>&1 || true
    fi
}
_remux_restore_scrollback_once

typeset -g _REMUX_CLAUDE_WRAPPER=""
_remux_install_claude_wrapper() {
    local integration_dir="${REMUX_SHELL_INTEGRATION_DIR:-}"
    [[ -n "$integration_dir" ]] || return 0

    integration_dir="${integration_dir%/}"
    local bundle_dir="${integration_dir%/shell-integration}"
    local wrapper_path="$bundle_dir/bin/claude"
    [[ -x "$wrapper_path" ]] || return 0

    # Keep the bundled claude wrapper ahead of later PATH mutations. Install it
    # via eval so an existing `alias claude=...` cannot break parsing.
    _REMUX_CLAUDE_WRAPPER="$wrapper_path"
    builtin unalias claude >/dev/null 2>&1 || true
    eval 'claude() { "$_REMUX_CLAUDE_WRAPPER" "$@"; }'
}
_remux_install_claude_wrapper

# Throttle heavy work to avoid prompt latency.
typeset -g _REMUX_PWD_LAST_PWD=""
typeset -g _REMUX_GIT_LAST_PWD=""
typeset -g _REMUX_GIT_LAST_RUN=0
typeset -g _REMUX_GIT_JOB_PID=""
typeset -g _REMUX_GIT_JOB_STARTED_AT=0
typeset -g _REMUX_GIT_FORCE=0
typeset -g _REMUX_GIT_HEAD_LAST_PWD=""
typeset -g _REMUX_GIT_HEAD_PATH=""
typeset -g _REMUX_GIT_HEAD_SIGNATURE=""
typeset -g _REMUX_GIT_HEAD_WATCH_PID=""
typeset -g _REMUX_PR_POLL_PID=""
typeset -g _REMUX_PR_POLL_PWD=""
typeset -g _REMUX_PR_LAST_BRANCH=""
typeset -g _REMUX_PR_NO_PR_BRANCH=""
typeset -g _REMUX_PR_POLL_INTERVAL=45
typeset -g _REMUX_PR_FORCE=0
typeset -g _REMUX_PR_DEBUG=${_REMUX_PR_DEBUG:-0}
typeset -g _REMUX_ASYNC_JOB_TIMEOUT=20

typeset -g _REMUX_PORTS_LAST_RUN=0
typeset -g _REMUX_CMD_START=0
typeset -g _REMUX_SHELL_ACTIVITY_LAST=""
typeset -g _REMUX_TTY_NAME=""
typeset -g _REMUX_TTY_REPORTED=0
typeset -g _REMUX_GHOSTTY_SEMANTIC_PATCHED=0
typeset -g _REMUX_WINCH_GUARD_INSTALLED=0
typeset -g _REMUX_TMUX_PUSH_SIGNATURE=""
typeset -g _REMUX_TMUX_PULL_SIGNATURE=""
typeset -ga _REMUX_TMUX_SYNC_KEYS=(
    REMUX_BUNDLED_CLI_PATH
    REMUX_BUNDLE_ID
    REMUXD_UNIX_PATH
    REMUXTERM_REPO_ROOT
    REMUX_DEBUG_LOG
    REMUX_LOAD_GHOSTTY_ZSH_INTEGRATION
    REMUX_PORT
    REMUX_PORT_END
    REMUX_PORT_RANGE
    REMUX_REMOTE_DAEMON_ALLOW_LOCAL_BUILD
    REMUX_SHELL_INTEGRATION
    REMUX_SHELL_INTEGRATION_DIR
    REMUX_SOCKET_ENABLE
    REMUX_SOCKET_MODE
    REMUX_SOCKET_PATH
    REMUX_TAB_ID
    REMUX_TAG
    REMUX_WORKSPACE_ID
)
typeset -ga _REMUX_TMUX_SURFACE_SCOPED_KEYS=(
    REMUX_PANEL_ID
    REMUX_SURFACE_ID
)

_remux_tmux_sync_key_is_managed() {
    local candidate="$1"
    local key
    for key in "${_REMUX_TMUX_SYNC_KEYS[@]}"; do
        [[ "$key" == "$candidate" ]] && return 0
    done
    return 1
}

_remux_tmux_shell_env_signature() {
    local key value
    local -a parts
    for key in "${_REMUX_TMUX_SYNC_KEYS[@]}"; do
        value="${(P)key}"
        [[ -n "$value" ]] || continue
        parts+=("${key}=${value}")
    done
    print -r -- "${(j:\x1f:)parts}"
}

_remux_tmux_publish_remux_environment() {
    [[ -z "$TMUX" ]] || return 0
    command -v tmux >/dev/null 2>&1 || return 0

    local signature
    signature="$(_remux_tmux_shell_env_signature)"
    [[ -n "$signature" ]] || return 0
    [[ "$signature" == "$_REMUX_TMUX_PUSH_SIGNATURE" ]] && return 0

    local key value
    for key in "${_REMUX_TMUX_SYNC_KEYS[@]}"; do
        value="${(P)key}"
        [[ -n "$value" ]] || continue
        tmux set-environment -g "$key" "$value" >/dev/null 2>&1 || return 0
    done

    for key in "${_REMUX_TMUX_SURFACE_SCOPED_KEYS[@]}"; do
        tmux set-environment -gu "$key" >/dev/null 2>&1 || return 0
    done

    _REMUX_TMUX_PUSH_SIGNATURE="$signature"
}

_remux_tmux_refresh_remux_environment() {
    [[ -n "$TMUX" ]] || return 0
    command -v tmux >/dev/null 2>&1 || return 0

    local output
    output="$(tmux show-environment -g 2>/dev/null)" || return 0

    local line key filtered="" did_change=0
    while IFS= read -r line; do
        [[ "$line" == REMUX_* ]] || continue
        key="${line%%=*}"
        _remux_tmux_sync_key_is_managed "$key" || continue
        filtered+="${line}"$'\n'
    done <<< "$output"

    [[ -n "$filtered" ]] || return 0
    [[ "$filtered" == "$_REMUX_TMUX_PULL_SIGNATURE" ]] && return 0

    local value
    while IFS= read -r line; do
        [[ "$line" == REMUX_* ]] || continue
        key="${line%%=*}"
        _remux_tmux_sync_key_is_managed "$key" || continue
        value="${line#*=}"
        if [[ "${(P)key}" != "$value" ]]; then
            export "$key=$value"
            did_change=1
        fi
    done <<< "$filtered"

    _REMUX_TMUX_PULL_SIGNATURE="$filtered"
    if (( did_change )); then
        _REMUX_TTY_REPORTED=0
        _REMUX_SHELL_ACTIVITY_LAST=""
        _REMUX_PWD_LAST_PWD=""
        _REMUX_GIT_LAST_PWD=""
        _REMUX_GIT_HEAD_LAST_PWD=""
        _REMUX_GIT_HEAD_PATH=""
        _REMUX_GIT_HEAD_SIGNATURE=""
        _REMUX_GIT_FORCE=1
        _REMUX_PR_FORCE=1
        _remux_stop_pr_poll_loop
        _remux_stop_git_head_watch
    fi
}

_remux_tmux_sync_remux_environment() {
    if [[ -n "$TMUX" ]]; then
        _remux_tmux_refresh_remux_environment
    else
        _remux_tmux_publish_remux_environment
    fi
}

_remux_ensure_ghostty_preexec_strips_both_marks() {
    local fn_name="$1"
    (( $+functions[$fn_name] )) || return 0

    local old_strip new_strip updated
    old_strip=$'PS1=${PS1//$\'%{\\e]133;A;cl=line\\a%}\'}'
    new_strip=$'PS1=${PS1//$\'%{\\e]133;A;redraw=last;cl=line\\a%}\'}'
    updated="${functions[$fn_name]}"

    if [[ "$updated" == *"$new_strip"* && "$updated" != *"$old_strip"* ]]; then
        updated="${updated/$new_strip/$old_strip
        $new_strip}"
        functions[$fn_name]="$updated"
        _REMUX_GHOSTTY_SEMANTIC_PATCHED=1
        return 0
    fi
    if [[ "$updated" == *"$old_strip"* && "$updated" != *"$new_strip"* ]]; then
        updated="${updated/$old_strip/$old_strip
        $new_strip}"
        functions[$fn_name]="$updated"
        _REMUX_GHOSTTY_SEMANTIC_PATCHED=1
    fi
}

_remux_patch_ghostty_semantic_redraw() {
    local old_frag new_frag
    old_frag='133;A;cl=line'
    new_frag='133;A;redraw=last;cl=line'

    # Patch both deferred and live hook definitions, depending on init timing.
    if (( $+functions[_ghostty_deferred_init] )); then
        functions[_ghostty_deferred_init]="${functions[_ghostty_deferred_init]//$old_frag/$new_frag}"
        _REMUX_GHOSTTY_SEMANTIC_PATCHED=1
    fi
    if (( $+functions[_ghostty_precmd] )); then
        functions[_ghostty_precmd]="${functions[_ghostty_precmd]//$old_frag/$new_frag}"
        _REMUX_GHOSTTY_SEMANTIC_PATCHED=1
    fi
    if (( $+functions[_ghostty_preexec] )); then
        functions[_ghostty_preexec]="${functions[_ghostty_preexec]//$old_frag/$new_frag}"
        _REMUX_GHOSTTY_SEMANTIC_PATCHED=1
    fi

    # Keep legacy + redraw-aware strip lines so prompts created before patching
    # are still cleared by preexec.
    _remux_ensure_ghostty_preexec_strips_both_marks _ghostty_deferred_init
    _remux_ensure_ghostty_preexec_strips_both_marks _ghostty_preexec
}
_remux_patch_ghostty_semantic_redraw

_remux_prompt_wrap_guard() {
    local cmd_start="$1"
    local pwd="$2"
    [[ -n "$cmd_start" && "$cmd_start" != 0 ]] || return 0

    local cols="${COLUMNS:-0}"
    (( cols > 0 )) || return 0

    local budget=$(( cols - 24 ))
    (( budget < 20 )) && budget=20
    (( ${#pwd} >= budget )) || return 0

    # Keep a spacer line between command output and a wrapped prompt so
    # resize-driven prompt redraw cannot overwrite the command tail.
    builtin print -r -- ""
}

_remux_install_winch_guard() {
    (( _REMUX_WINCH_GUARD_INSTALLED )) && return 0

    # Respect user-defined WINCH handlers (function-based or trap-based).
    local existing_winch_trap=""
    existing_winch_trap="$(trap -p WINCH 2>/dev/null || true)"
    if (( $+functions[TRAPWINCH] )) || [[ -n "$existing_winch_trap" ]]; then
        _REMUX_WINCH_GUARD_INSTALLED=1
        return 0
    fi

    TRAPWINCH() {
        [[ -n "$REMUX_TAB_ID" ]] || return 0
        [[ -n "$REMUX_PANEL_ID" ]] || return 0

        # Ghostty already marks prompt redraws on SIGWINCH. Writing to the PTY
        # here grows the screen and makes resize look like a fresh prompt.
        return 0
    }

    _REMUX_WINCH_GUARD_INSTALLED=1
}
_remux_install_winch_guard

_remux_git_resolve_head_path() {
    # Resolve the HEAD file path without invoking git (fast; works for worktrees).
    local dir="$PWD"
    while true; do
        if [[ -d "$dir/.git" ]]; then
            print -r -- "$dir/.git/HEAD"
            return 0
        fi
        if [[ -f "$dir/.git" ]]; then
            local line gitdir
            line="$(<"$dir/.git")"
            if [[ "$line" == gitdir:* ]]; then
                gitdir="${line#gitdir:}"
                gitdir="${gitdir## }"
                gitdir="${gitdir%% }"
                [[ -n "$gitdir" ]] || return 1
                [[ "$gitdir" != /* ]] && gitdir="$dir/$gitdir"
                print -r -- "$gitdir/HEAD"
                return 0
            fi
        fi
        [[ "$dir" == "/" || -z "$dir" ]] && break
        dir="${dir:h}"
    done
    return 1
}

_remux_git_head_signature() {
    local head_path="$1"
    [[ -n "$head_path" && -r "$head_path" ]] || return 1
    local line=""
    if IFS= read -r line < "$head_path"; then
        print -r -- "$line"
        return 0
    fi
    return 1
}

_remux_report_tty_payload() {
    [[ -n "$REMUX_TAB_ID" ]] || return 0
    [[ -n "$_REMUX_TTY_NAME" ]] || return 0

    local payload="report_tty $_REMUX_TTY_NAME --tab=$REMUX_TAB_ID"
    if [[ -z "$TMUX" ]]; then
        [[ -n "$REMUX_PANEL_ID" ]] || return 0
        payload+=" --panel=$REMUX_PANEL_ID"
    fi

    print -r -- "$payload"
}

_remux_report_tty_once() {
    # Send the TTY name to the app once per session so the batched port scanner
    # knows which TTY belongs to this panel.
    (( _REMUX_TTY_REPORTED )) && return 0
    [[ -S "$REMUX_SOCKET_PATH" ]] || return 0

    local payload=""
    payload="$(_remux_report_tty_payload)"
    [[ -n "$payload" ]] || return 0

    _REMUX_TTY_REPORTED=1
    _remux_send_bg "$payload"
}

_remux_report_shell_activity_state() {
    local state="$1"
    [[ -n "$state" ]] || return 0
    [[ -S "$REMUX_SOCKET_PATH" ]] || return 0
    [[ -n "$REMUX_TAB_ID" ]] || return 0
    [[ -n "$REMUX_PANEL_ID" ]] || return 0
    [[ "$_REMUX_SHELL_ACTIVITY_LAST" == "$state" ]] && return 0
    _REMUX_SHELL_ACTIVITY_LAST="$state"
    _remux_send_bg "report_shell_state $state --tab=$REMUX_TAB_ID --panel=$REMUX_PANEL_ID"
}

_remux_ports_kick() {
    # Lightweight: just tell the app to run a batched scan for this panel.
    # The app coalesces kicks across all panels and runs a single ps+lsof.
    [[ -S "$REMUX_SOCKET_PATH" ]] || return 0
    [[ -n "$REMUX_TAB_ID" ]] || return 0
    [[ -n "$REMUX_PANEL_ID" ]] || return 0
    _REMUX_PORTS_LAST_RUN=$EPOCHSECONDS
    _remux_send_bg "ports_kick --tab=$REMUX_TAB_ID --panel=$REMUX_PANEL_ID"
}

_remux_report_git_branch_for_path() {
    local repo_path="$1"
    [[ -n "$repo_path" ]] || return 0
    [[ -S "$REMUX_SOCKET_PATH" ]] || return 0
    [[ -n "$REMUX_TAB_ID" ]] || return 0
    [[ -n "$REMUX_PANEL_ID" ]] || return 0

    # Skip git operations if not in a git repository to avoid TCC prompts
    git -C "$repo_path" rev-parse --git-dir >/dev/null 2>&1 || return 0

    local branch dirty_opt="" first
    branch="$(git -C "$repo_path" branch --show-current 2>/dev/null)"
    if [[ -n "$branch" ]]; then
        first="$(git -C "$repo_path" status --porcelain -uno 2>/dev/null | head -1)"
        [[ -n "$first" ]] && dirty_opt="--status=dirty"
        _remux_send "report_git_branch $branch $dirty_opt --tab=$REMUX_TAB_ID --panel=$REMUX_PANEL_ID"
    else
        _remux_send "clear_git_branch --tab=$REMUX_TAB_ID --panel=$REMUX_PANEL_ID"
    fi
}

_remux_clear_pr_for_panel() {
    [[ -S "$REMUX_SOCKET_PATH" ]] || return 0
    [[ -n "$REMUX_TAB_ID" ]] || return 0
    [[ -n "$REMUX_PANEL_ID" ]] || return 0
    _remux_send_bg "clear_pr --tab=$REMUX_TAB_ID --panel=$REMUX_PANEL_ID"
}

_remux_pr_output_indicates_no_pull_request() {
    local output="${1:l}"
    [[ "$output" == *"no pull requests found"* \
        || "$output" == *"no pull request found"* \
        || "$output" == *"no pull requests associated"* \
        || "$output" == *"no pull request associated"* ]]
}

_remux_github_repo_slug_for_path() {
    local repo_path="$1"
    local remote_url="" path_part=""
    [[ -n "$repo_path" ]] || return 0

    remote_url="$(git -C "$repo_path" remote get-url origin 2>/dev/null)"
    [[ -n "$remote_url" ]] || return 0

    case "$remote_url" in
        git@github.com:*)
            path_part="${remote_url#git@github.com:}"
            ;;
        ssh://git@github.com/*)
            path_part="${remote_url#ssh://git@github.com/}"
            ;;
        https://github.com/*)
            path_part="${remote_url#https://github.com/}"
            ;;
        http://github.com/*)
            path_part="${remote_url#http://github.com/}"
            ;;
        git://github.com/*)
            path_part="${remote_url#git://github.com/}"
            ;;
        *)
            return 0
            ;;
    esac

    path_part="${path_part%.git}"
    [[ "$path_part" == */* ]] || return 0
    print -r -- "$path_part"
}

_remux_pr_cache_prefix() {
    [[ -n "$REMUX_PANEL_ID" ]] || return 1
    print -r -- "/tmp/remux-pr-cache-${REMUX_PANEL_ID}"
}

_remux_pr_force_signal_path() {
    [[ -n "$REMUX_PANEL_ID" ]] || return 1
    print -r -- "/tmp/remux-pr-force-${REMUX_PANEL_ID}"
}

_remux_pr_debug_log() {
    (( _REMUX_PR_DEBUG )) || return 0

    local branch="$1"
    local event="$2"
    local now="${EPOCHSECONDS:-$SECONDS}"
    printf '%s\tbranch=%s\tevent=%s\n' "$now" "$branch" "$event" >> /tmp/remux-pr-debug.log
}

_remux_pr_cache_clear() {
    local prefix=""
    prefix="$(_remux_pr_cache_prefix 2>/dev/null || true)"
    if [[ -n "$prefix" ]]; then
        /bin/rm -f -- \
            "${prefix}.branch" \
            "${prefix}.repo" \
            "${prefix}.result" \
            "${prefix}.timestamp" \
            "${prefix}.no-pr-branch" \
            >/dev/null 2>&1 || true
    fi

    _REMUX_PR_LAST_BRANCH=""
    _REMUX_PR_NO_PR_BRANCH=""
}

_remux_pr_request_probe() {
    local signal_path=""
    signal_path="$(_remux_pr_force_signal_path 2>/dev/null || true)"
    [[ -n "$signal_path" ]] || return 0
    : >| "$signal_path"
}

_remux_report_pr_for_path() {
    local repo_path="$1"
    local force_probe="${2:-0}"
    [[ -n "$repo_path" ]] || {
        _remux_pr_cache_clear
        _remux_clear_pr_for_panel
        return 0
    }
    [[ -d "$repo_path" ]] || {
        _remux_pr_cache_clear
        _remux_clear_pr_for_panel
        return 0
    }
    [[ -S "$REMUX_SOCKET_PATH" ]] || return 0
    [[ -n "$REMUX_TAB_ID" ]] || return 0
    [[ -n "$REMUX_PANEL_ID" ]] || return 0

    local branch repo_slug="" gh_output="" gh_error="" err_file="" number state url status_opt="" gh_status
    local now="${EPOCHSECONDS:-$SECONDS}"
    local prefix="" branch_file="" repo_file="" result_file="" timestamp_file="" no_pr_branch_file=""
    local cache_branch="" cache_result="" cache_no_pr_branch=""
    local -a gh_repo_args
    gh_repo_args=()
    branch="$(git -C "$repo_path" branch --show-current 2>/dev/null)"
    if [[ -z "$branch" ]] || ! command -v gh >/dev/null 2>&1; then
        _remux_pr_debug_log "$branch" "cache-miss:clear"
        _remux_pr_cache_clear
        _remux_clear_pr_for_panel
        return 0
    fi

    prefix="$(_remux_pr_cache_prefix 2>/dev/null || true)"
    if [[ -n "$prefix" ]]; then
        branch_file="${prefix}.branch"
        repo_file="${prefix}.repo"
        result_file="${prefix}.result"
        timestamp_file="${prefix}.timestamp"
        no_pr_branch_file="${prefix}.no-pr-branch"
        [[ -r "$branch_file" ]] && cache_branch="$(<"$branch_file")"
        [[ -r "$result_file" ]] && cache_result="$(<"$result_file")"
        [[ -r "$no_pr_branch_file" ]] && cache_no_pr_branch="$(<"$no_pr_branch_file")"
    fi

    _REMUX_PR_LAST_BRANCH="$cache_branch"
    _REMUX_PR_NO_PR_BRANCH="$cache_no_pr_branch"
    if [[ "$cache_branch" == "$branch" && -n "$cache_result" ]]; then
        _remux_pr_debug_log "$branch" "cache-refresh"
    else
        _remux_pr_debug_log "$branch" "cache-miss"
    fi

    repo_slug="$(_remux_github_repo_slug_for_path "$repo_path")"
    if [[ -n "$repo_slug" ]]; then
        gh_repo_args=(--repo "$repo_slug")
    fi

    err_file="$(/usr/bin/mktemp "${TMPDIR:-/tmp}/remux-gh-pr-view.XXXXXX" 2>/dev/null || true)"
    [[ -n "$err_file" ]] || return 1
    gh_output="$(
        builtin cd "$repo_path" 2>/dev/null \
            && gh pr view "$branch" \
                "${gh_repo_args[@]}" \
                --json number,state,url \
                --jq '[.number, .state, .url] | @tsv' \
                2>"$err_file"
    )"
    gh_status=$?
    if [[ -f "$err_file" ]]; then
        gh_error="$("/bin/cat" -- "$err_file" 2>/dev/null || true)"
        /bin/rm -f -- "$err_file" >/dev/null 2>&1 || true
    fi

    if (( gh_status != 0 )) || [[ -z "$gh_output" ]]; then
        if (( gh_status == 0 )) && [[ -z "$gh_output" ]]; then
            if [[ -n "$prefix" ]]; then
                print -r -- "$branch" >| "$branch_file"
                print -r -- "$repo_path" >| "$repo_file"
                print -r -- "$now" >| "$timestamp_file"
                print -r -- "none" >| "$result_file"
                print -r -- "$branch" >| "$no_pr_branch_file"
            fi
            _REMUX_PR_LAST_BRANCH="$branch"
            _REMUX_PR_NO_PR_BRANCH="$branch"
            _remux_clear_pr_for_panel
            return 0
        fi
        if _remux_pr_output_indicates_no_pull_request "$gh_error"; then
            if [[ -n "$prefix" ]]; then
                print -r -- "$branch" >| "$branch_file"
                print -r -- "$repo_path" >| "$repo_file"
                print -r -- "$now" >| "$timestamp_file"
                print -r -- "none" >| "$result_file"
                print -r -- "$branch" >| "$no_pr_branch_file"
            fi
            _REMUX_PR_LAST_BRANCH="$branch"
            _REMUX_PR_NO_PR_BRANCH="$branch"
            _remux_clear_pr_for_panel
            return 0
        fi

        # Always scope PR detection to the exact current branch. When gh fails
        # transiently (auth hiccups, API lag, rate limiting), keep the last-known
        # badge and retry on the next poll instead of showing a mismatched PR.
        return 1
    fi

    local IFS=$'\t'
    read -r number state url <<< "$gh_output"
    if [[ -z "$number" ]] || [[ -z "$url" ]]; then
        return 1
    fi

    case "$state" in
        MERGED) status_opt="--state=merged" ;;
        OPEN) status_opt="--state=open" ;;
        CLOSED) status_opt="--state=closed" ;;
        *) return 1 ;;
    esac

    if [[ -n "$prefix" ]]; then
        print -r -- "$branch" >| "$branch_file"
        print -r -- "$repo_path" >| "$repo_file"
        print -r -- "$now" >| "$timestamp_file"
        printf '%s\t%s\t%s\t%s\n' "pr" "$number" "$state" "$url" >| "$result_file"
        /bin/rm -f -- "$no_pr_branch_file" >/dev/null 2>&1 || true
    fi
    _REMUX_PR_LAST_BRANCH="$branch"
    _REMUX_PR_NO_PR_BRANCH=""

    local quoted_branch="${branch//\"/\\\"}"
    _remux_send "report_pr $number $url $status_opt --branch=\"$quoted_branch\" --tab=$REMUX_TAB_ID --panel=$REMUX_PANEL_ID"
}

_remux_child_pids() {
    local parent_pid="$1"
    [[ -n "$parent_pid" ]] || return 0
    /bin/ps -ax -o pid= -o ppid= 2>/dev/null | /usr/bin/awk -v parent="$parent_pid" '$2 == parent { print $1 }'
}

_remux_kill_process_tree() {
    local pid="$1"
    local signal="${2:-TERM}"
    local child_pid=""
    [[ -n "$pid" ]] || return 0

    while IFS= read -r child_pid; do
        [[ -n "$child_pid" ]] || continue
        [[ "$child_pid" == "$pid" ]] && continue
        _remux_kill_process_tree "$child_pid" "$signal"
    done < <(_remux_child_pids "$pid")

    kill "-$signal" "$pid" >/dev/null 2>&1 || true
}

_remux_run_pr_probe_with_timeout() {
    local repo_path="$1"
    local force_probe="${2:-0}"
    local probe_pid=""
    local started_at="${EPOCHSECONDS:-$SECONDS}"
    local now=$started_at

    (
        _remux_report_pr_for_path "$repo_path" "$force_probe"
    ) &
    probe_pid=$!

    while kill -0 "$probe_pid" >/dev/null 2>&1; do
        sleep 1
        now="${EPOCHSECONDS:-$SECONDS}"
        if (( _REMUX_ASYNC_JOB_TIMEOUT > 0 )) && (( now - started_at >= _REMUX_ASYNC_JOB_TIMEOUT )); then
            _remux_kill_process_tree "$probe_pid" TERM
            sleep 0.2
            if kill -0 "$probe_pid" >/dev/null 2>&1; then
                _remux_kill_process_tree "$probe_pid" KILL
                sleep 0.2
            fi
            if ! kill -0 "$probe_pid" >/dev/null 2>&1; then
                wait "$probe_pid" >/dev/null 2>&1 || true
            fi
            return 1
        fi
    done

    wait "$probe_pid"
}

_remux_halt_pr_poll_loop() {
    if [[ -n "$_REMUX_PR_POLL_PID" ]]; then
        # Process-group kill: background jobs are process-group leaders, so
        # negative PID kills the loop + all descendants (gh, sleep) without
        # the synchronous /bin/ps + awk of tree-kill (~5-13ms).
        kill -KILL -- -"$_REMUX_PR_POLL_PID" 2>/dev/null || true
    fi
    local signal_path=""
    signal_path="$(_remux_pr_force_signal_path 2>/dev/null || true)"
    [[ -n "$signal_path" ]] && /bin/rm -f -- "$signal_path" >/dev/null 2>&1 || true
    _REMUX_PR_POLL_PID=""
    _REMUX_PR_POLL_PWD=""
}

_remux_stop_pr_poll_loop() {
    _remux_halt_pr_poll_loop
    _remux_pr_cache_clear
}

_remux_start_pr_poll_loop() {
    [[ -S "$REMUX_SOCKET_PATH" ]] || return 0
    [[ -n "$REMUX_TAB_ID" ]] || return 0
    [[ -n "$REMUX_PANEL_ID" ]] || return 0

    local watch_pwd="${1:-$PWD}"
    local force_restart="${2:-0}"
    local watch_shell_pid="$$"
    local interval="${_REMUX_PR_POLL_INTERVAL:-45}"

    if [[ "$force_restart" != "1" && "$watch_pwd" == "$_REMUX_PR_POLL_PWD" && -n "$_REMUX_PR_POLL_PID" ]] \
        && kill -0 "$_REMUX_PR_POLL_PID" 2>/dev/null; then
        return 0
    fi

    if [[ -n "$_REMUX_PR_POLL_PID" ]] && kill -0 "$_REMUX_PR_POLL_PID" 2>/dev/null; then
        _remux_halt_pr_poll_loop
    else
        _REMUX_PR_POLL_PID=""
    fi
    _REMUX_PR_POLL_PWD="$watch_pwd"

    {
        local signal_path=""
        signal_path="$(_remux_pr_force_signal_path 2>/dev/null || true)"
        while true; do
            kill -0 "$watch_shell_pid" >/dev/null 2>&1 || break
            local force_probe=0
            if [[ -n "$signal_path" && -f "$signal_path" ]]; then
                force_probe=1
                /bin/rm -f -- "$signal_path" >/dev/null 2>&1 || true
            fi
            _remux_run_pr_probe_with_timeout "$watch_pwd" "$force_probe" || true

            local slept=0
            while (( slept < interval )); do
                kill -0 "$watch_shell_pid" >/dev/null 2>&1 || exit 0
                if [[ -n "$signal_path" && -f "$signal_path" ]]; then
                    break
                fi
                sleep 1
                slept=$(( slept + 1 ))
            done
        done
    } >/dev/null 2>&1 &!
    _REMUX_PR_POLL_PID=$!
}

_remux_stop_git_head_watch() {
    if [[ -n "$_REMUX_GIT_HEAD_WATCH_PID" ]]; then
        kill "$_REMUX_GIT_HEAD_WATCH_PID" >/dev/null 2>&1 || true
        _REMUX_GIT_HEAD_WATCH_PID=""
    fi
}

_remux_start_git_head_watch() {
    [[ -S "$REMUX_SOCKET_PATH" ]] || return 0
    [[ -n "$REMUX_TAB_ID" ]] || return 0
    [[ -n "$REMUX_PANEL_ID" ]] || return 0

    local watch_pwd="$PWD"
    local watch_head_path
    watch_head_path="$(_remux_git_resolve_head_path 2>/dev/null || true)"
    [[ -n "$watch_head_path" ]] || return 0

    local watch_head_signature
    watch_head_signature="$(_remux_git_head_signature "$watch_head_path" 2>/dev/null || true)"

    _REMUX_GIT_HEAD_LAST_PWD="$watch_pwd"
    _REMUX_GIT_HEAD_PATH="$watch_head_path"
    _REMUX_GIT_HEAD_SIGNATURE="$watch_head_signature"

    _remux_stop_git_head_watch
    {
        local last_signature="$watch_head_signature"
        while true; do
            sleep 1

            local signature
            signature="$(_remux_git_head_signature "$watch_head_path" 2>/dev/null || true)"
            if [[ -n "$signature" && "$signature" != "$last_signature" ]]; then
                last_signature="$signature"
                _remux_pr_cache_clear
                _remux_report_git_branch_for_path "$watch_pwd"
                _remux_clear_pr_for_panel
                if [[ -n "$_REMUX_PR_POLL_PID" ]] && kill -0 "$_REMUX_PR_POLL_PID" 2>/dev/null; then
                    _remux_pr_request_probe
                else
                    _remux_run_pr_probe_with_timeout "$watch_pwd" 1 || true
                fi
            fi
        done
    } >/dev/null 2>&1 &!
    _REMUX_GIT_HEAD_WATCH_PID=$!
}

_remux_command_starts_nested_shell() {
    local cmd="$1"
    local -a words
    words=("${(z)cmd}")

    local index=1
    local word base
    while (( index <= ${#words} )); do
        word="${words[index]}"

        case "$word" in
            *=*)
                index=$(( index + 1 ))
                continue ;;
            exec|command|builtin|noglob|time)
                index=$(( index + 1 ))
                continue ;;
            env)
                index=$(( index + 1 ))
                while (( index <= ${#words} )); do
                    word="${words[index]}"
                    case "$word" in
                        -*|*=*)
                            index=$(( index + 1 ))
                            continue ;;
                    esac
                    break
                done
                continue ;;
        esac

        base="${word:t}"
        case "$base" in
            bash|zsh|sh|fish|nu|nix-shell)
                return 0 ;;
            nix)
                local next_index=$(( index + 1 ))
                local next_word="${words[next_index]}"
                case "$next_word" in
                    develop|shell)
                        return 0 ;;
                esac ;;
        esac

        return 1
    done

    return 1
}

_remux_preexec() {
    _remux_tmux_sync_remux_environment

    if [[ -z "$_REMUX_TTY_NAME" ]]; then
        local t
        t="$(tty 2>/dev/null || true)"
        t="${t##*/}"
        [[ -n "$t" && "$t" != "not a tty" ]] && _REMUX_TTY_NAME="$t"
    fi

    _REMUX_CMD_START=$EPOCHSECONDS
    _remux_report_shell_activity_state running

    # Heuristic: commands that may change git branch/dirty state without changing $PWD.
    local cmd="${1## }"
    case "$cmd" in
        git\ *|git|gh\ *|lazygit|lazygit\ *|tig|tig\ *|gitui|gitui\ *|stg\ *|jj\ *)
            _REMUX_GIT_FORCE=1
            _REMUX_PR_FORCE=1 ;;
    esac

    # Register TTY + kick batched port scan for foreground commands (servers).
    _remux_report_tty_once
    _remux_ports_kick
    _remux_halt_pr_poll_loop
    _remux_stop_git_head_watch
    if _remux_command_starts_nested_shell "$cmd"; then
        return 0
    fi
    _remux_start_git_head_watch
}

_remux_precmd() {
    _remux_stop_git_head_watch
    _remux_tmux_sync_remux_environment

    # Skip if socket doesn't exist yet
    [[ -S "$REMUX_SOCKET_PATH" ]] || return 0
    [[ -n "$REMUX_TAB_ID" ]] || return 0
    [[ -n "$REMUX_PANEL_ID" ]] || return 0
    _remux_report_shell_activity_state prompt

    # Handle cases where Ghostty integration initializes after this file.
    (( _REMUX_GHOSTTY_SEMANTIC_PATCHED )) || _remux_patch_ghostty_semantic_redraw

    if [[ -z "$_REMUX_TTY_NAME" ]]; then
        local t
        t="$(tty 2>/dev/null || true)"
        t="${t##*/}"
        [[ -n "$t" && "$t" != "not a tty" ]] && _REMUX_TTY_NAME="$t"
    fi

    _remux_report_tty_once

    local now=$EPOCHSECONDS
    local pwd="$PWD"
    local cmd_start="$_REMUX_CMD_START"
    _REMUX_CMD_START=0

    _remux_prompt_wrap_guard "$cmd_start" "$pwd"

    # Post-wake socket writes can occasionally leave a probe process wedged.
    # If one probe is stale, clear the guard so fresh async probes can resume.
    if [[ -n "$_REMUX_GIT_JOB_PID" ]]; then
        if ! kill -0 "$_REMUX_GIT_JOB_PID" 2>/dev/null; then
            _REMUX_GIT_JOB_PID=""
            _REMUX_GIT_JOB_STARTED_AT=0
        elif (( _REMUX_GIT_JOB_STARTED_AT > 0 )) && (( now - _REMUX_GIT_JOB_STARTED_AT >= _REMUX_ASYNC_JOB_TIMEOUT )); then
            _REMUX_GIT_JOB_PID=""
            _REMUX_GIT_JOB_STARTED_AT=0
            _REMUX_GIT_FORCE=1
        fi
    fi

    # CWD: keep the app in sync with the actual shell directory.
    # This is also the simplest way to test sidebar directory behavior end-to-end.
    if [[ "$pwd" != "$_REMUX_PWD_LAST_PWD" ]]; then
        _REMUX_PWD_LAST_PWD="$pwd"
        local qpwd="${pwd//\"/\\\"}"
        _remux_send_bg "report_pwd \"${qpwd}\" --tab=$REMUX_TAB_ID --panel=$REMUX_PANEL_ID"
    fi

    # Git branch/dirty: update immediately on directory change, otherwise every ~3s.
    # While a foreground command is running, _remux_start_git_head_watch probes HEAD
    # once per second so agent-initiated git checkouts still surface quickly.
    local should_git=0
    local git_head_changed=0

    # Git branch can change without a `git ...`-prefixed command (aliases like `gco`,
    # tools like `gh pr checkout`, etc.). Detect HEAD changes and force a refresh.
    if [[ "$pwd" != "$_REMUX_GIT_HEAD_LAST_PWD" ]]; then
        _REMUX_GIT_HEAD_LAST_PWD="$pwd"
        _REMUX_GIT_HEAD_PATH="$(_remux_git_resolve_head_path 2>/dev/null || true)"
        _REMUX_GIT_HEAD_SIGNATURE=""
    fi
    if [[ -n "$_REMUX_GIT_HEAD_PATH" ]]; then
        local head_signature
        head_signature="$(_remux_git_head_signature "$_REMUX_GIT_HEAD_PATH" 2>/dev/null || true)"
        if [[ -n "$head_signature" ]]; then
            if [[ -z "$_REMUX_GIT_HEAD_SIGNATURE" ]]; then
                # The first observed HEAD value establishes the baseline for this
                # shell session. Don't treat it as a branch change or we'll clear
                # restore-seeded PR badges before the first background probe runs.
                _REMUX_GIT_HEAD_SIGNATURE="$head_signature"
            elif [[ "$head_signature" != "$_REMUX_GIT_HEAD_SIGNATURE" ]]; then
                _REMUX_GIT_HEAD_SIGNATURE="$head_signature"
                git_head_changed=1
                # Treat HEAD file change like a git command — force-replace any
                # running probe so the sidebar picks up the new branch immediately.
                _REMUX_GIT_FORCE=1
                _REMUX_PR_FORCE=1
                should_git=1
            fi
        fi
    fi

    if [[ "$pwd" != "$_REMUX_GIT_LAST_PWD" ]]; then
        should_git=1
    elif (( _REMUX_GIT_FORCE )); then
        should_git=1
    elif (( now - _REMUX_GIT_LAST_RUN >= 3 )); then
        should_git=1
    fi

    if (( should_git )); then
        local can_launch_git=1
        if [[ -n "$_REMUX_GIT_JOB_PID" ]] && kill -0 "$_REMUX_GIT_JOB_PID" 2>/dev/null; then
            # If a stale probe is still running but the cwd changed (or we just ran
            # a git command), restart immediately so branch state isn't delayed
            # until the next user command/prompt.
            # Note: this repeats the cwd check above on purpose. The first check
            # decides whether we should refresh at all; this one decides whether
            # an in-flight older probe can be reused vs. replaced.
            if [[ "$pwd" != "$_REMUX_GIT_LAST_PWD" ]] || (( _REMUX_GIT_FORCE )); then
                kill "$_REMUX_GIT_JOB_PID" >/dev/null 2>&1 || true
                _REMUX_GIT_JOB_PID=""
                _REMUX_GIT_JOB_STARTED_AT=0
            else
                can_launch_git=0
            fi
        fi

        if (( can_launch_git )); then
            _REMUX_GIT_FORCE=0
            _REMUX_GIT_LAST_PWD="$pwd"
            _REMUX_GIT_LAST_RUN=$now
            {
                _remux_report_git_branch_for_path "$pwd"
            } >/dev/null 2>&1 &!
            _REMUX_GIT_JOB_PID=$!
            _REMUX_GIT_JOB_STARTED_AT=$now
        fi
    fi

    # Pull request metadata is remote state. Keep a lightweight background poll
    # alive while the shell is idle so gh-created PRs and merge status changes
    # appear even without another prompt.
    local should_restart_pr_poll=0
    local should_signal_pr_probe=0
    local pr_context_changed=0
    if [[ -n "$_REMUX_PR_POLL_PWD" && "$pwd" != "$_REMUX_PR_POLL_PWD" ]]; then
        pr_context_changed=1
    elif (( git_head_changed )); then
        pr_context_changed=1
    fi
    if [[ "$pwd" != "$_REMUX_PR_POLL_PWD" ]]; then
        should_restart_pr_poll=1
    elif (( _REMUX_PR_FORCE )); then
        if [[ -n "$_REMUX_PR_POLL_PID" ]] && kill -0 "$_REMUX_PR_POLL_PID" 2>/dev/null; then
            should_signal_pr_probe=1
        else
            should_restart_pr_poll=1
        fi
    elif [[ -z "$_REMUX_PR_POLL_PID" ]] || ! kill -0 "$_REMUX_PR_POLL_PID" 2>/dev/null; then
        should_restart_pr_poll=1
    fi

    if (( pr_context_changed )); then
        _remux_pr_cache_clear
        _remux_clear_pr_for_panel
    fi

    if (( should_signal_pr_probe )); then
        _REMUX_PR_FORCE=0
        _remux_pr_request_probe
    fi

    if (( should_restart_pr_poll )); then
        _REMUX_PR_FORCE=0
        _remux_start_pr_poll_loop "$pwd" 1
    fi

    # Ports: lightweight kick to the app's batched scanner.
    # - Periodic scan to avoid stale values.
    # - Forced scan when a long-running command returns to the prompt (common when stopping a server).
    local cmd_dur=0
    if [[ -n "$cmd_start" && "$cmd_start" != 0 ]]; then
        cmd_dur=$(( now - cmd_start ))
    fi

    if (( cmd_dur >= 2 || now - _REMUX_PORTS_LAST_RUN >= 10 )); then
        _remux_ports_kick
    fi
}

# Ensure Resources/bin is at the front of PATH, and remove the app's
# Contents/MacOS entry so the GUI remux binary cannot shadow the CLI remux.
# Shell init (.zprofile/.zshrc) may prepend other dirs after launch.
# We fix this once on first prompt (after all init files have run).
_remux_fix_path() {
    if [[ -n "${GHOSTTY_BIN_DIR:-}" ]]; then
        local gui_dir="${GHOSTTY_BIN_DIR%/}"
        local bin_dir="${gui_dir%/MacOS}/Resources/bin"
        if [[ -d "$bin_dir" ]]; then
            # Remove existing entries and re-prepend the CLI bin dir.
            local -a parts=("${(@s/:/)PATH}")
            parts=("${(@)parts:#$bin_dir}")
            parts=("${(@)parts:#$gui_dir}")
            PATH="${bin_dir}:${(j/:/)parts}"
        fi
    fi
    add-zsh-hook -d precmd _remux_fix_path
}

_remux_zshexit() {
    _remux_stop_git_head_watch
    _remux_stop_pr_poll_loop
}

autoload -Uz add-zsh-hook
add-zsh-hook preexec _remux_preexec
add-zsh-hook precmd _remux_precmd
add-zsh-hook precmd _remux_fix_path
add-zsh-hook zshexit _remux_zshexit
