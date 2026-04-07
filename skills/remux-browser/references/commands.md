# Command Reference (remux Browser)

This maps common `agent-browser` usage to `remux browser` usage.

## Direct Equivalents

- `agent-browser open <url>` -> `remux browser open <url>`
- `agent-browser goto|navigate <url>` -> `remux browser <surface> goto|navigate <url>`
- `agent-browser snapshot -i` -> `remux browser <surface> snapshot --interactive`
- `agent-browser click <ref>` -> `remux browser <surface> click <ref>`
- `agent-browser fill <ref> <text>` -> `remux browser <surface> fill <ref> <text>`
- `agent-browser type <ref> <text>` -> `remux browser <surface> type <ref> <text>`
- `agent-browser select <ref> <value>` -> `remux browser <surface> select <ref> <value>`
- `agent-browser get text <ref>` -> `remux browser <surface> get text <ref-or-selector>`
- `agent-browser get url` -> `remux browser <surface> get url`
- `agent-browser get title` -> `remux browser <surface> get title`

## Core Command Groups

### Navigation

```bash
remux browser open <url>                        # opens in caller's workspace (uses REMUX_WORKSPACE_ID)
remux browser open <url> --workspace <id|ref>   # opens in a specific workspace
remux browser <surface> goto <url>
remux browser <surface> back|forward|reload
remux browser <surface> get url|title
```

> **Workspace context:** `browser open` targets the workspace of the terminal where the command is run (via `REMUX_WORKSPACE_ID`), even if a different workspace is currently focused. Use `--workspace` to override.

### Snapshot and Inspection

```bash
remux browser <surface> snapshot --interactive
remux browser <surface> snapshot --interactive --compact --max-depth 3
remux browser <surface> get text body
remux browser <surface> get html body
remux browser <surface> get value "#email"
remux browser <surface> get attr "#email" --attr placeholder
remux browser <surface> get count ".row"
remux browser <surface> get box "#submit"
remux browser <surface> get styles "#submit" --property color
remux browser <surface> eval '<js>'
```

### Interaction

```bash
remux browser <surface> click|dblclick|hover|focus <selector-or-ref>
remux browser <surface> fill <selector-or-ref> [text]   # empty text clears
remux browser <surface> type <selector-or-ref> <text>
remux browser <surface> press|keydown|keyup <key>
remux browser <surface> select <selector-or-ref> <value>
remux browser <surface> check|uncheck <selector-or-ref>
remux browser <surface> scroll [--selector <css>] [--dx <n>] [--dy <n>]
```

### Wait

```bash
remux browser <surface> wait --selector "#ready" --timeout-ms 10000
remux browser <surface> wait --text "Done" --timeout-ms 10000
remux browser <surface> wait --url-contains "/dashboard" --timeout-ms 10000
remux browser <surface> wait --load-state complete --timeout-ms 15000
remux browser <surface> wait --function "document.readyState === 'complete'" --timeout-ms 10000
```

### Session/State

```bash
remux browser <surface> cookies get|set|clear ...
remux browser <surface> storage local|session get|set|clear ...
remux browser <surface> tab list|new|switch|close ...
remux browser <surface> state save|load <path>
```

### Diagnostics

```bash
remux browser <surface> console list|clear
remux browser <surface> errors list|clear
remux browser <surface> highlight <selector>
remux browser <surface> screenshot
remux browser <surface> download wait --timeout-ms 10000
```

## Agent Reliability Tips

- Use `--snapshot-after` on mutating actions to return a fresh post-action snapshot.
- Re-snapshot after navigation, modal open/close, or major DOM changes.
- Prefer short handles in outputs by default (`surface:N`, `pane:N`, `workspace:N`, `window:N`).
- Use `--id-format both` only when a UUID must be logged/exported.

## Known WKWebView Gaps (`not_supported`)

- `browser.viewport.set`
- `browser.geolocation.set`
- `browser.offline.set`
- `browser.trace.start|stop`
- `browser.network.route|unroute|requests`
- `browser.screencast.start|stop`
- `browser.input_mouse|input_keyboard|input_touch`

See also:
- [snapshot-refs.md](snapshot-refs.md)
- [authentication.md](authentication.md)
- [session-management.md](session-management.md)
