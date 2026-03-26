# Zellij Real E2E Audit

Date: 2026-03-26
Repository: `remux`
Scope: Current `zellij` mode behavior validated through real browser E2E against a real local `zellij 0.44.0`

## Status Update

The findings below were reproduced first, then fixed on `feat/zellij-e2e-audit`.

Resolved in this branch:

- external session rename now preserves the attached web view instead of falling back to another session
- `new tab` now selects the created tab even when zellij leaves backend focus behind
- scroll mode now requests real pane scrollback through `capture_scrollback`
- the initial zellij bootstrap shell and Remux-created tabs/panes now receive `REMUX=1`
- a frontend `Focus Sync` control now exposes `set_follow_focus`
- the top-title `Select Session (experimental)` spacing issue is fixed

## Summary

This pass confirms that the main gaps in `zellij` mode are no longer just abstract architecture concerns. Several user-visible failures are reproducible today in the real product:

- attached clients can drift away from real backend truth
- session rename from another client can kick the web client onto the wrong session
- the "scroll" view is not real zellij scrollback
- the documented `REMUX`-based tmux-launcher mitigation does not actually reach the shell pane
- `new tab` behavior still feels wrong compared to a first-class workspace client

These are not fake-backend issues. They showed up in a real browser session against a real `zellij` server path.

## Environment

- Host: local macOS machine
- Node build: `npm run build`
- Target backend: `node dist/backend/cli.js --backend zellij --host 127.0.0.1 --port 8876 --tunnel false --require-password false`
- Zellij version: `zellij 0.44.0`
- Browser automation: `playwright-cli`
- Socket isolation: `REMUX_ZELLIJ_SOCKET_DIR=/tmp/remux-zellij-e2e.Ywypl0`

## Existing Tests Checked First

Before the real browser pass, I ran:

```bash
npm test -- --run tests/backend/zellij-parser.test.ts tests/integration/zellij-server.test.ts
```

Result:

- `2` files passed
- `21` tests passed

This is useful baseline coverage, but it does not prove the real `zellij CLI -> subscribe -> websocket -> xterm -> UI` path.

## Findings

### 1. External Session Rename Can Move the Client to the Wrong Session

Severity: High

Reproduction:

1. Start Remux in real `zellij` mode.
2. Create a new session from the UI, attach to it, then keep the browser open.
3. Rename that attached session from outside Remux:

```bash
ZELLIJ_SOCKET_DIR=/tmp/remux-zellij-e2e.Ywypl0 zellij --session audit2 action rename-session audit2r
```

Observed:

- after the next poll window, the browser session list updates to `audit2r`
- but the active attached view falls back to `main`
- the top status changed to `attached: main`

This is a real multi-client correctness failure. A rename performed by another real zellij client can silently move the Remux user onto a different session.

Relevant code:

- [src/backend/view/client-view-store.ts](/Users/wangyaoshen/dev/remux/.worktrees/zellij-e2e-audit/src/backend/view/client-view-store.ts#L58) falls back to the first available session after two missing polls
- [src/backend/server.ts](/Users/wangyaoshen/dev/remux/.worktrees/zellij-e2e-audit/src/backend/server.ts#L1022) only updates `viewStore.renameSession()` when the rename flows through the Remux control protocol

Why it happens:

- the server has a recovery path for renames initiated by Remux itself
- it does not have a comparable path for renames initiated by another real zellij client
- once the old session name disappears from polling snapshots, the client-view fallback logic reattaches to the first session

### 2. The Browser View Can Diverge from Real Zellij Focus, and There Is No Frontend Control to Fix It

Severity: High

Reproduction:

1. Attach Remux to a zellij session with multiple tabs.
2. In the browser, keep viewing tab `0`.
3. From outside Remux, switch the real zellij session focus:

```bash
ZELLIJ_SOCKET_DIR=/tmp/remux-zellij-e2e.Ywypl0 zellij --session audit2 action go-to-tab 2
```

Observed:

- `zellij action list-tabs --json --all` reported tab `1` as `active: true`
- after waiting longer than the poll interval, the browser still showed tab `0` as active

This is not just "follow focus is off by default". The product currently exposes no browser control to turn that behavior on, even though the backend protocol supports it.

Relevant code:

- [src/backend/view/client-view-store.ts](/Users/wangyaoshen/dev/remux/.worktrees/zellij-e2e-audit/src/backend/view/client-view-store.ts#L12) initializes every client with `followBackendFocus: false`
- [src/backend/view/client-view-store.ts](/Users/wangyaoshen/dev/remux/.worktrees/zellij-e2e-audit/src/backend/view/client-view-store.ts#L97) only syncs to backend truth if that flag is enabled
- [src/backend/server.ts](/Users/wangyaoshen/dev/remux/.worktrees/zellij-e2e-audit/src/backend/server.ts#L523) overlays client view state onto workspace state and marks the viewed tab/pane as active
- [src/backend/server.ts](/Users/wangyaoshen/dev/remux/.worktrees/zellij-e2e-audit/src/backend/server.ts#L1060) supports `set_follow_focus`, but the frontend does not expose it

Impact:

- the browser can present a different "active tab" from the real zellij session
- another client can move real focus without Remux showing it
- the user cannot opt into backend-truth-following from the current UI

### 3. The Scroll View Is Not Real Zellij Scrollback

Severity: High

Reproduction:

1. In a real attached zellij session, run:

```bash
seq 1 120
```

2. Switch Remux from terminal mode to scroll mode.
3. Compare the browser output with direct zellij screen capture:

```bash
ZELLIJ_SOCKET_DIR=/tmp/remux-zellij-e2e.Ywypl0 zellij --session audit2 action dump-screen --pane-id terminal_0 --full --ansi
```

Observed:

- Remux scroll mode only showed the last visible viewport section (`102` through `120` plus prompt)
- direct `dump-screen --full` returned the full history including `1` through `120`

So the current "Scroll" UI in zellij mode is not approximate scrollback. It is mostly the serialized xterm viewport buffer.

Relevant code:

- [src/frontend/hooks/useScrollbackView.ts](/Users/wangyaoshen/dev/remux/.worktrees/zellij-e2e-audit/src/frontend/hooks/useScrollbackView.ts#L22) reads scroll content from `readTerminalBuffer()` and `terminal.onWriteParsed()`
- [src/backend/zellij/cli-executor.ts](/Users/wangyaoshen/dev/remux/.worktrees/zellij-e2e-audit/src/backend/zellij/cli-executor.ts#L291) already has a real `capturePane()` implementation via `dump-screen --full`, but the active frontend path does not use it

Impact:

- users get a misleading history viewer
- long outputs cannot be reviewed reliably
- the `(approx)` badge understates the gap; this is closer to "current viewport mirror" than real scrollback

### 4. The `REMUX` Guard Does Not Reach the Actual Zellij Shell Pane

Severity: High

Reproduction:

1. Attach to a real zellij session created by Remux.
2. Run in the browser compose bar:

```bash
printf "<%s>\n" "$REMUX"
```

Observed:

- the browser output was `<>`

That means the shell inside the pane does not actually see `REMUX` set.

Why this matters:

- the server explicitly tells users to guard tmux-launcher scripts with `if [ -n "$REMUX" ]`
- in real runtime, that mitigation does not hold if the variable is absent in the pane
- `newTab()` also does not inject the variable at all

Relevant code:

- [src/backend/server.ts](/Users/wangyaoshen/dev/remux/.worktrees/zellij-e2e-audit/src/backend/server.ts#L768) warns users to rely on `$REMUX` to stop nested tmux launchers
- [src/backend/zellij/cli-executor.ts](/Users/wangyaoshen/dev/remux/.worktrees/zellij-e2e-audit/src/backend/zellij/cli-executor.ts#L350) sets `REMUX=1` only on the bootstrap attach process
- [src/backend/zellij/cli-executor.ts](/Users/wangyaoshen/dev/remux/.worktrees/zellij-e2e-audit/src/backend/zellij/cli-executor.ts#L175) creates new tabs with `zellij action new-tab -- ...shell` and no explicit `REMUX` propagation

Impact:

- nested shell launchers remain a real risk in zellij mode
- the current user guidance is not trustworthy as-is
- tab creation can behave unpredictably in environments that auto-start tmux

### 5. `New Tab` Does Not Feel Correct in Zellij Mode

Severity: Medium

Reproduction:

1. Attach to a real zellij session in Remux.
2. Click `New tab`.
3. Inspect the browser tab strip and backend tab state.

Observed in this pass:

- the new tab appeared after the zellij poll/update cycle
- the browser stayed on the old tab
- browser state showed the old tab still active
- backend `list-tabs --json --all` also kept the old tab active in the tested path

From a user perspective, this feels wrong. The action is "new tab", but Remux leaves the user in the previous view with no direct transition to the newly created tab.

Relevant code:

- [src/backend/zellij/cli-executor.ts](/Users/wangyaoshen/dev/remux/.worktrees/zellij-e2e-audit/src/backend/zellij/cli-executor.ts#L175) issues `new-tab`
- [src/backend/server.ts](/Users/wangyaoshen/dev/remux/.worktrees/zellij-e2e-audit/src/backend/server.ts#L892) updates the client view based on whichever tab the next snapshot reports as active

This is not a crash, but it makes zellij mode feel like a compatibility layer rather than a first-class workspace UX.

### 6. Minor UI Polish: Session Picker Title Renders as `Select Session(experimental)`

Severity: Low

Observed:

- when multiple sessions exist, the top title renders as `Select Session(experimental)` with no spacing

Relevant code:

- [src/frontend/components/AppHeader.tsx](/Users/wangyaoshen/dev/remux/.worktrees/zellij-e2e-audit/src/frontend/components/AppHeader.tsx#L259)

This is minor, but it reinforces the unfinished feel right at the point where zellij mode already asks the user to make an attachment choice.

## What I Did Not Reproduce in This Pass

These areas were not confirmed as broken in this specific real-browser pass:

- browser console errors on initial load
- basic compose-bar input delivery
- creating a new session from the UI
- initial session picker flow itself

That should not be read as "zellij mode is healthy". It only means those particular paths did not fail during this audit.

## Conclusions

The current zellij mode still has multiple correctness and product-honesty problems that matter in real usage:

1. Multi-client truth is unreliable.
2. Scrollback is not real.
3. Shell bootstrapping assumptions are not trustworthy.
4. Key interactions still do not feel native or coherent.

If the goal is "zellij as a first-class backend on par with tmux", these findings support a zellij-first cleanup plan, not a small bugfix pass.

## Recommended Next Steps

1. Make backend truth and client view explicit in the UI, and surface a real follow-focus control.
2. Replace zellij scroll mode with a real `capturePane()` path instead of xterm serialization.
3. Fix shell/bootstrap environment propagation so the `$REMUX` guidance is actually true.
4. Add a real zellij browser regression suite that covers:
   - external tab focus changes
   - external session rename
   - long-output scrollback
   - new-tab behavior
5. Decide explicitly whether Remux should follow zellij's real focus semantics or provide a clearly labeled client-local view mode. The current hybrid is confusing.
