# Windows and Workspaces

Window/workspace lifecycle and ordering operations.

## Inspect

```bash
remux list-windows
remux current-window
remux list-workspaces
remux current-workspace
```

## Create/Focus/Close

```bash
remux new-window
remux focus-window --window window:2
remux close-window --window window:2

remux new-workspace
remux select-workspace --workspace workspace:4
remux close-workspace --workspace workspace:4
```

## Reorder and Move

```bash
remux reorder-workspace --workspace workspace:4 --before workspace:2
remux move-workspace-to-window --workspace workspace:4 --window window:1
```
