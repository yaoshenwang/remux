# Zellij Tab-Only Runtime Refactor Plan

> Status: Draft
> Date: 2026-03-27
> Scope: Replace the current pane-centric zellij integration with a tab-only runtime model where panes remain an internal zellij implementation detail and Remux exposes only `session -> tab -> fullscreen terminal`.

---

## 1. Background

The current Remux zellij path is in an unstable middle state:

- terminal output is already "glass pane" style through native pane render subscription
- terminal geometry is still driven by a real zellij pane
- the frontend still receives and stores `paneId`
- the live terminal path still treats pane width as a source of truth

This creates the width bug loop:

1. the browser fits xterm to the visible container
2. zellij reports the current pane content width
3. the frontend shrinks xterm back to that pane width
4. the terminal surface becomes narrower than the visible container

This is not a CSS bug. It is an architectural bug caused by exposing zellij pane semantics directly into the Remux live terminal model.

The user-facing target is simpler:

- one session contains tabs
- one tab maps to one fullscreen terminal surface in the browser
- pane concepts do not appear in the zellij-mode UI
- split-pane and pane-local behaviors are not part of the Remux zellij product surface

The refactor must therefore stop treating panes as part of the public model.

---

## 2. Decision

Remux zellij mode will become a **tab-only runtime**.

This means:

- `paneId` is removed from the frontend-facing zellij model
- browser state tracks `sessionName + tabIndex`, not `sessionName + tabIndex + paneId`
- zellij panes still exist internally because zellij is pane-based, but they become backend-private implementation details
- live terminal geometry is owned by the Remux browser/runtime path, not by a shared real pane width
- Remux zellij mode supports **single-terminal tabs only**

This is a product and architecture decision, not just a bugfix.

---

## 3. User-Facing Contract

### 3.1 What the user sees

In zellij mode, the browser exposes:

- session picker
- tab list
- one fullscreen terminal for the selected tab
- inspect/history for the selected tab

The browser does not expose:

- pane IDs
- pane switching
- pane splitting
- floating panes
- pane fullscreen toggles

### 3.2 What the browser guarantees

For every selected zellij tab:

1. the live terminal surface fills the intended terminal container width
2. xterm geometry is derived from the browser container and confirmed by the Remux-owned runtime path
3. no shared real pane width may force xterm to shrink after fit
4. the browser view is always a single fullscreen terminal surface

### 3.3 What is explicitly unsupported

If a zellij tab becomes multi-pane from another client:

- Remux must not pretend this is still a valid fullscreen live terminal tab
- Remux must degrade explicitly

Allowed degradation choices:

- mark the tab unsupported for live mode and allow inspect/history only
- or auto-recreate the tab as a Remux-managed single-terminal tab if that behavior is explicitly chosen later

The first implementation should choose the honest unsupported path.

---

## 4. Architecture Principles

1. Pane is an internal zellij implementation detail, not a frontend domain concept.
2. Live terminal geometry has exactly one source of truth.
3. `workspace_state` must not drive live terminal width.
4. The hidden Remux-owned zellij runtime path is authoritative for terminal size confirmation.
5. Multi-pane zellij features are out of scope for the Remux zellij product surface.

---

## 5. Target Architecture

```text
Frontend
  sessionName + tabIndex
        |
        v
Control protocol
  no paneId in zellij live path
        |
        v
Zellij tab runtime
  resolves the internal terminal pane for the selected tab
        |
        +--> native bridge pane render subscription
        |
        +--> Remux-owned resize client
        |
        +--> single-tab capability / health checks
        v
xterm geometry confirmation
```

### 5.1 Important boundary

The backend may still internally track:

- current terminal pane ID for the active tab
- zellij tab ID
- render stream source
- runtime health

But these are backend-private fields. They do not belong in the frontend protocol or in zellij-mode UI state.

---

## 6. Ordered Refactor Plan

This section is the implementation order. Follow it strictly. Do not start by tweaking xterm layout again.

### Phase 0. Freeze the old pane UX surface

Goal:

- prevent new pane-specific behavior from expanding while the refactor is underway

Steps:

1. Mark zellij pane actions as deprecated in the code comments and internal planning docs.
2. Decide the exact zellij product surface to keep:
   - keep `new_tab`
   - keep `close_tab`
   - keep `rename_tab`
   - keep tab switching
   - drop pane split/focus/fullscreen/floating behavior from the zellij UI path
3. Add a temporary internal assertion document entry: zellij live mode requires one visible terminal surface per tab.

Exit criteria:

- the team is no longer treating pane-preserving parity as a target for zellij mode

### Phase 1. Introduce a zellij tab-only domain model

Goal:

- stop modeling zellij live view as `session + tab + pane`

Steps:

1. Add a zellij-specific internal runtime view type:
   - `sessionName`
   - `tabIndex`
   - optional backend-private `terminalPaneId`
2. Stop using frontend `paneId` as the zellij live view selector.
3. Keep pane IDs only inside backend adapters and internal runtime state.
4. Define a single backend-private method:
   - resolve the active terminal pane for a given `session + tab`

Exit criteria:

- the frontend zellij live selection path no longer depends on `paneId`

### Phase 2. Split protocol truth: workspace metadata vs live terminal geometry

Goal:

- make it impossible for `workspace_state` to mutate xterm width directly

Steps:

1. Remove zellij live-width dependence on `workspace_state.sessions[].tabs[].panes[].width`.
2. Introduce a separate runtime geometry message for the attached zellij tab terminal:
   - requested cols/rows
   - confirmed cols/rows
   - stable / syncing state
3. Make `workspace_state` purely structural:
   - sessions
   - tabs
   - status/capabilities
   - no live geometry authority
4. Keep pane metadata out of the zellij frontend payload, or mark it backend-only if transitional compatibility is needed briefly.

Exit criteria:

- no frontend zellij live width logic reads pane width from workspace snapshots

### Phase 3. Build a dedicated zellij tab runtime

Goal:

- replace `session:paneId` attachment as the main zellij runtime unit

Steps:

1. Introduce a zellij runtime object keyed by `session + tabIndex`.
2. Inside that runtime:
   - resolve the current terminal pane for the tab
   - subscribe to native bridge render updates for that pane
   - own resize confirmation for the tab terminal
3. Keep pane re-resolution internal so that if zellij reallocates pane identity after a tab recreation, the frontend does not care.
4. Reattach logic should be based on tab change, not pane change.

Exit criteria:

- zellij live runtime attachment is tab-scoped from the server API point of view

### Phase 4. Enforce single-terminal-tab constraints

Goal:

- make the tab-only product honest and stable

Steps:

1. Define the valid zellij live-tab shape:
   - exactly one selectable terminal pane
   - no floating panes
   - no plugin-only surface presented as terminal
2. Add backend validation on attach and on workspace refresh.
3. If validation fails:
   - do not stream live terminal as if everything were normal
   - emit an explicit degraded state for that tab
4. Hide pane-oriented controls in zellij mode.

Exit criteria:

- Remux never silently renders a multi-pane zellij tab as a fake fullscreen live terminal

### Phase 5. Move geometry authority to the Remux-owned runtime path

Goal:

- make browser width the only intended terminal geometry source

Steps:

1. Keep browser fit based on the real terminal container.
2. Send requested cols/rows to the zellij tab runtime.
3. Let the backend perform resize and confirmation internally.
4. Publish only confirmed runtime geometry back to the frontend.
5. Remove the frontend "fit then shrink back to pane width" logic entirely.

Important rule:

- xterm may only resize from:
  - local fit proposal before initial attach
  - or confirmed runtime geometry after backend confirmation

It may not resize from pane width embedded in workspace metadata.

Exit criteria:

- the width bug loop is structurally impossible

### Phase 6. Remove pane semantics from the zellij frontend

Goal:

- align UI with the new model

Steps:

1. Remove zellij pane selection UI paths.
2. Remove zellij split-pane UI actions.
3. Remove zellij pane fullscreen behavior from sticky zoom logic.
4. Rename any remaining zellij live state labels so they speak in tab terms, not pane terms.
5. Keep inspect/history tab-scoped.

Exit criteria:

- the zellij frontend experience is fully tab-first

### Phase 7. Simplify backend control surface

Goal:

- stop carrying dead pane APIs through the main zellij path

Steps:

1. Gate pane-specific backend capabilities off in zellij mode.
2. Keep pane operations only as backend-internal helpers where unavoidable.
3. Remove assumptions that every backend must expose the same pane UX.
4. Audit `ClientViewStore`, session attach flow, and control message handlers for pane-centric logic.

Exit criteria:

- zellij mode no longer depends on pane-facing control mutations in the public product flow

### Phase 8. Rewrite tests around the new invariants

Goal:

- stop testing the wrong contract

Add tests for:

1. zellij attach chooses `session + tab`, not `session + pane`
2. workspace snapshots do not drive live terminal geometry
3. live xterm width stays aligned with the visible terminal container across:
   - initial attach
   - sidebar collapse
   - viewport change
   - reconnect
4. multi-pane external tab mutation degrades explicitly
5. zellij mode exposes no pane controls in the browser

Remove or rewrite tests that assume:

- pane selection is a first-class zellij user action
- workspace pane width should drive xterm width

Exit criteria:

- tests encode the tab-only model, not the old pane model

---

## 7. File-Level Execution Order

This is the practical edit order to minimize churn.

1. `docs/` design docs first
2. shared protocol and frontend state types
3. backend view store and session attach flow
4. zellij runtime layer
5. frontend live terminal width logic
6. zellij-mode UI controls
7. integration and E2E tests

Recommended concrete sequence:

1. add the new design document
2. define the new zellij live runtime state shape
3. stop frontend zellij live code from reading pane width
4. add backend geometry confirmation messages
5. switch runtime attachment from `session:paneId` to `session:tab`
6. add single-terminal-tab validation
7. remove pane actions from zellij UI
8. rewrite real-browser zellij width tests

---

## 8. Required Code Changes by Area

### 8.1 Shared contracts

Expected changes:

- separate live terminal geometry from workspace snapshot shape
- remove zellij frontend dependence on `paneId`

### 8.2 Backend session attach flow

Expected changes:

- zellij attach initializes tab-scoped runtime state
- `ClientViewStore` no longer treats pane as required for zellij live mode

### 8.3 Zellij runtime

Expected changes:

- replace pane-scoped public attachment semantics
- keep pane resolution internal
- own resize request + confirmation flow

### 8.4 Frontend terminal runtime

Expected changes:

- remove the zellij-specific shrink-back workaround
- consume confirmed runtime geometry instead

### 8.5 Frontend UI

Expected changes:

- remove pane controls in zellij mode
- present one fullscreen terminal per tab

---

## 9. Migration Risks

### Risk 1. Internal pane resolution still leaks into the UI

Mitigation:

- treat any new frontend need for `paneId` as a design failure

### Risk 2. Multi-pane external mutations become common

Mitigation:

- degrade explicitly instead of faking fullscreen correctness

### Risk 3. Geometry confirmation adds latency

Mitigation:

- keep the last confirmed geometry until the new size is stable
- do not oscillate xterm width during sync

### Risk 4. Trying to preserve old pane tests slows the refactor

Mitigation:

- rewrite tests to the new contract early

---

## 10. Acceptance Criteria

The refactor is complete only when all of the following are true:

1. zellij live mode no longer exposes pane concepts in the browser
2. xterm width is never shrunk from workspace pane width
3. zellij live runtime is selected by tab, not by pane, from the public server/frontend point of view
4. multi-pane zellij tabs degrade honestly
5. the real-browser width invariant passes without any pane-width workaround logic

---

## 11. Verification Plan

Before claiming completion, verify:

- `npm run typecheck`
- `npm test`
- `npm run build`
- real browser zellij width E2E
- mandatory manual real-web width spot-check against an actual terminal view

The manual zellij width spot-check must confirm:

- first paint width matches the visible terminal container
- live output width stays aligned after interaction and resize
- no half-width rendering
- no early wrapping caused by stale terminal columns

---

## 12. Immediate Next Step

The first implementation task is not another width patch.

The first implementation task is:

**remove pane width from the zellij live frontend geometry path and introduce a separate confirmed geometry channel.**

That is the earliest point where the current width bug stops being structurally inevitable.
