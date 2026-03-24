# Zellij Mode Audit

Date: 2026-03-25
Repository: `remux`
Scope: Current `zellij` backend behavior, frontend experience, architecture fit, and iteration space
Author: Codex analysis summary

## Executive Summary

The current `zellij` mode is not mainly suffering from isolated bugs. The larger issue is a model mismatch:

- Remux is still fundamentally `tmux-first`
- `zellij` is adapted into the same protocol and UI shape
- The frontend often shows a client-specific virtual view, not the real backend state
- Terminal streaming is not a true PTY stream, but a viewport reconstruction
- Several operations depend on fragile focus inference and backend-specific hacks

Result: the product can appear usable in simple cases, but the experience becomes inconsistent, surprising, and unreliable in real usage.

This means `zellij` mode should not be treated as a normal bugfix stream. It needs:

1. A short-term stabilization pass
2. A medium-term protocol and state-model correction
3. A larger zellij-first refactor if the goal is a genuinely good experience

## What Was Analyzed

I reviewed:

- Backend zellij implementation
- Shared protocol and multiplexer abstraction
- Server-side client view and state overlay logic
- Frontend `App.tsx` state flow and zellij-specific behavior
- Existing zellij tests
- Existing design document: [docs/ZELLIJ_FIRST_REFACTOR.md](./ZELLIJ_FIRST_REFACTOR.md)

I also ran the app in real `zellij` mode and inspected behavior with a real local `zellij 0.44.0` installation.

## Validation Performed

### Code Review

Files inspected included:

- `src/backend/zellij/cli-executor.ts`
- `src/backend/zellij/pane-io.ts`
- `src/backend/zellij/parser.ts`
- `src/backend/server.ts`
- `src/backend/view/client-view-store.ts`
- `src/backend/multiplexer/types.ts`
- `src/frontend/App.tsx`
- `tests/integration/zellij-server.test.ts`
- `docs/ZELLIJ_FIRST_REFACTOR.md`

### Real Runtime Validation

Executed:

- `node dist/backend/cli.js --backend zellij --host 127.0.0.1 --port 8767 --tunnel false --require-password false`
- Real browser session against the running app
- Real CLI inspection with `zellij --session main action list-tabs --json --all`
- Real CLI inspection with `zellij --session main action list-panes --json --all`

### Existing Test Validation

Executed:

```bash
npm test -- --run tests/backend/zellij-parser.test.ts tests/integration/zellij-server.test.ts
```

Result:

- `2` test files passed
- `18` tests passed

Important limitation:

- these tests mainly validate parser logic and fake zellij-style server behavior
- they do not validate the real `zellij CLI -> subscribe -> runtime -> frontend` chain

## Core Conclusion

The current `zellij` experience is strange because the system is trying to present `zellij` through `tmux` assumptions.

That causes three categories of failure:

1. State truth mismatch
2. Terminal semantics mismatch
3. Interaction model mismatch

This is the reason the mode feels globally wrong rather than locally broken.

## Findings

### 1. Real Backend State and Displayed UI State Are Different

The server overlays a per-client virtual view on top of backend state and marks that as active in `workspace_state`.

Relevant files:

- `src/backend/server.ts`
- `src/backend/view/client-view-store.ts`

Observed behavior:

- The page can show a tab as active for the current client
- Real `zellij` CLI output can still report no corresponding active tab state in the session snapshot being shown to the UI

Why this is bad:

- The UI stops being an honest reflection of the backend
- Debugging becomes difficult
- Multi-client behavior becomes confusing
- User actions appear to affect “the current tab” even when that is only a client-local concept

Required fix:

- Stop mutating backend truth into client truth
- Send both:
  - real workspace state
  - client-local view state
- Make the UI explicitly distinguish:
  - real active tab/pane
  - currently viewed tab/pane

### 2. `split_pane` Is Fragile in Real Zellij and Currently Fails in Practice

`splitPane()` depends on focusing a pane through a WASM plugin before creating the new pane.

Relevant file:

- `src/backend/zellij/cli-executor.ts`

Observed real runtime result:

- Clicking `Split H` triggered a server log containing `focus pipe failed`

Impact:

- Split behavior is not trustworthy
- The user gets a broken interaction on a primary pane-management action
- Failure is effectively softened instead of clearly surfaced as unavailable capability

Required fix:

- Add plugin health checks at startup
- If focus plugin support is unavailable, disable dependent UI actions
- Longer term: remove operation designs that depend on “focus first, then act”

### 3. Focus Plugin Has Version-Compatibility Risk

The plugin dependency is pinned to `zellij-tile = "0.41.2"`, while the validated runtime here was `zellij 0.44.0`.

Relevant files:

- `src/backend/zellij/plugin/Cargo.toml`
- `src/backend/zellij/plugin/src/lib.rs`

This is an inference, but a strong one:

- even if the plugin works in some environments, compatibility drift is a credible risk

Required fix:

- Define supported zellij version range explicitly
- Perform startup version validation
- Add real smoke tests for plugin-based focus behavior
- Do not assume shipping a `.wasm` file is enough to guarantee runtime compatibility

### 4. `paneSessionMap` Can Drift

The zellij backend caches `paneId -> sessionName` during `listPanes()`.

Relevant file:

- `src/backend/zellij/cli-executor.ts`

Problem:

- This cache is not modeled as an authoritative index
- It is populated during polling and then reused by mutations
- Structural changes can make it stale

Impact:

- Pane-targeted operations may execute with stale context
- Bugs can appear after split, close, rename, or state transitions

Required fix:

- Replace it with an explicit `PaneIndex`
- Rebuild atomically on snapshot creation
- Update it on every structural mutation

### 5. Snapshot Building Is Poll-Heavy and Redundant

The snapshot path is expensive for zellij:

- `buildSnapshot()` calls `listSessions`
- then `listTabs` per session
- then `listPanes` per tab
- and `listPanes` itself fetches tabs again and panes again

Relevant files:

- `src/backend/multiplexer/types.ts`
- `src/backend/zellij/cli-executor.ts`

Impact:

- unnecessary command volume
- more latency
- more backend overhead
- worse behavior as workspace complexity grows

Required fix:

- Make zellij snapshot building fetch tabs and panes once per session
- Stop shaping zellij queries around tmux assumptions
- Longer term: move toward event-driven state with polling as fallback

### 6. Terminal Stream Is Not a Real PTY Stream

Current zellij output is subscribe-based viewport reconstruction.

Relevant file:

- `src/backend/zellij/pane-io.ts`

Observed design:

- initial output includes scrollback plus viewport
- later updates diff viewport lines and write cursor-addressed output into xterm

Impact:

- scrollback semantics are approximate
- cursor semantics are fragile
- full-screen apps and redraw-heavy apps can feel wrong
- the product behaves like a viewport mirror, not a terminal stream

Required fix:

- Short term: label this honestly as viewport mode
- Longer term: rewrite the zellij stream layer around explicit viewport semantics and cursor handling

### 7. Scroll Mode Is Reading Local Xterm Buffer, Not Real Backend Scrollback

Frontend scroll mode currently serializes xterm’s local buffer and ignores the `scrollback` message path.

Relevant file:

- `src/frontend/App.tsx`

Impact:

- history is only as good as this client’s local buffer
- reconnects, pane switches, and late joins produce incomplete history
- users may believe they are seeing authoritative scrollback when they are not

Required fix:

- Restore backend-backed scrollback capture as the canonical source
- In zellij mode, explicitly mark it as approximate
- Treat local xterm serialization as a convenience cache only

### 8. Connection State Machine Is Dirty

On `auth_ok`, the frontend immediately opens terminal websocket flow, even if session selection has not finished.

Relevant file:

- `src/frontend/App.tsx`

Observed behavior:

- Session picker can be visible while top bar and terminal are already partially live

Impact:

- the user sees a half-attached UI
- connection state is ambiguous
- startup experience feels broken and inconsistent

Required fix:

- Do not open terminal socket until `attached`
- Do not render live tab title before session attach is complete
- Treat session selection as a distinct connection phase

### 9. Sticky Zoom Is a Poor Fit for Zellij

Sticky zoom auto-sends fullscreen toggles during tab/pane changes.

Relevant file:

- `src/frontend/App.tsx`

Impact:

- this is not a natural zellij interaction
- it can create surprising state changes
- it mixes navigation and layout mutation

Required fix:

- Default sticky zoom off for zellij
- Make follow/focus behavior explicit instead of hiding layout mutation inside selection
- Gate the feature by backend capability and backend type

### 10. Backend Capabilities Exist but the UI Barely Uses Them

Capabilities are received and stored but not meaningfully used to shape the interface.

Relevant file:

- `src/frontend/App.tsx`

Impact:

- the UI pretends tmux, zellij, and conpty behave similarly
- unsupported or approximate features are presented as fully supported

Required fix:

- Make the UI capability-driven
- Disable or hide unsupported actions
- Label approximate features clearly

### 11. `followBackendFocus` Exists in Protocol but Is Not Exposed in the UI

The backend and view store support follow-focus behavior. The frontend does not expose it.

Relevant files:

- `src/backend/server.ts`
- `src/backend/view/client-view-store.ts`

Impact:

- zellij’s most important view-mode distinction is missing
- users cannot choose between:
  - independent viewing
  - following real backend focus

Required fix:

- Add a visible `Follow Backend Focus` control in zellij mode
- Make it a first-class part of the interaction model

### 12. Xterm Width Is Forced to Match Pane Viewport Width

Frontend resizes xterm columns to zellij pane width as a workaround.

Relevant file:

- `src/frontend/App.tsx`

Backend resize is still a no-op in zellij mode:

- `src/backend/zellij/pane-io.ts`

Impact:

- this is a layout hack, not a real resize model
- the terminal is presented as if it is naturally sized, but it is actually being coerced into viewport dimensions

Required fix:

- Stop pretending zellij mode is a fully resizable PTY surface
- Present it as either:
  - a fixed-width viewport presentation
  - or a separately designed viewer surface

### 13. Shared Protocol Still Does Not Fully Carry Zellij’s Real Model

The protocol contains some zellij-oriented fields, but the parser and UI do not fully use them.

Relevant file:

- `src/backend/zellij/parser.ts`

Examples:

- tab IDs are not fully propagated into UI behavior
- floating pane information is not meaningfully surfaced

Impact:

- zellij-native UI cannot be built on top of incomplete truth

Required fix:

- Make the protocol honest first
- Then build zellij-native interaction on top of that truth

### 14. Test Coverage Direction Is Wrong

Current zellij integration tests use a fake zellij-style backend wrapper.

Relevant file:

- `tests/integration/zellij-server.test.ts`

Impact:

- tests prove the server can talk to a fake abstraction
- tests do not prove the real zellij product behavior is sound

Required fix:

- Add real zellij smoke tests
- Add at least one real browser path covering zellij mode end-to-end

## Iteration Space

### Short-Term Stabilization

Goal: stop the most visible breakage and user confusion without large refactor.

Recommended actions:

- Add zellij version gate at startup
- Add focus plugin health check
- Disable unsupported actions dynamically via capabilities
- Delay terminal attach until session attach completes
- Turn sticky zoom off by default in zellij mode
- Restore backend-backed scrollback path and label it approximate
- Surface failures explicitly instead of silently degrading

Expected result:

- fewer broken core interactions
- less misleading UI
- lower support/debug burden

### Medium-Term Product Correction

Goal: make zellij behavior conceptually honest.

Recommended actions:

- Separate real workspace state from client view state
- Expose `followBackendFocus` in UI
- Remove fake active-state overlay as the primary displayed truth
- Show viewport-mode and approximate-scrollback indicators
- Rework tab/pane status rendering so users can distinguish:
  - backend active
  - current local view

Expected result:

- product feels less confusing
- behavior becomes explainable
- multi-client semantics become tractable

### Long-Term Refactor

Goal: make zellij the primary supported backend model instead of a tmux-shaped adapter.

Recommended actions:

- Follow the direction in `docs/ZELLIJ_FIRST_REFACTOR.md`
- Build a multiplexer-neutral protocol that is actually used everywhere
- Replace `paneSessionMap` with a proper authoritative index
- Rewrite zellij stream handling
- Break `App.tsx` into backend-aware UI modules
- Build capability-first frontend rendering

Expected result:

- zellij mode stops feeling like a compatibility layer
- features become maintainable
- bug rate should drop because the model becomes coherent

## Recommended Priority Order

1. Stabilize the runtime surface
2. Correct state truth and view semantics
3. Rebuild the zellij-specific model and stream layer
4. Add real zellij smoke coverage

Expanded:

1. Plugin/version gate, capability-driven UI, attach timing, sticky zoom default, visible errors
2. Real workspace vs client view separation, follow-focus, scrollback honesty
3. Zellij-first backend/domain/frontend refactor
4. Real zellij smoke tests and browser validation

## Final Recommendation

Do not continue treating current zellij issues as a normal bug backlog.

The correct framing is:

- short-term: stabilize
- medium-term: stop lying about state
- long-term: refactor around zellij’s real model

If the product goal is “solid zellij remote client experience”, a zellij-first architecture is required.

If that level of investment is not desired, the safer product decision is to clearly de-emphasize zellij mode and present it as experimental.

## References

Primary internal references:

- [docs/ZELLIJ_FIRST_REFACTOR.md](./ZELLIJ_FIRST_REFACTOR.md)
- [src/backend/zellij/cli-executor.ts](/Users/wangyaoshen/dev/remux/.worktrees/zellij-audit-summary/src/backend/zellij/cli-executor.ts)
- [src/backend/zellij/pane-io.ts](/Users/wangyaoshen/dev/remux/.worktrees/zellij-audit-summary/src/backend/zellij/pane-io.ts)
- [src/backend/server.ts](/Users/wangyaoshen/dev/remux/.worktrees/zellij-audit-summary/src/backend/server.ts)
- [src/backend/view/client-view-store.ts](/Users/wangyaoshen/dev/remux/.worktrees/zellij-audit-summary/src/backend/view/client-view-store.ts)
- [src/backend/multiplexer/types.ts](/Users/wangyaoshen/dev/remux/.worktrees/zellij-audit-summary/src/backend/multiplexer/types.ts)
- [src/frontend/App.tsx](/Users/wangyaoshen/dev/remux/.worktrees/zellij-audit-summary/src/frontend/App.tsx)
- [tests/integration/zellij-server.test.ts](/Users/wangyaoshen/dev/remux/.worktrees/zellij-audit-summary/tests/integration/zellij-server.test.ts)
