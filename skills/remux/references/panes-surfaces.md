# Panes and Surfaces

Split layout, surface creation, focus, move, and reorder.

## Inspect

```bash
remux list-panes
remux list-pane-surfaces --pane pane:1
```

## Create Splits/Surfaces

```bash
remux new-split right --panel pane:1
remux new-surface --type terminal --pane pane:1
remux new-surface --type browser --pane pane:1 --url https://example.com
```

## Focus and Close

```bash
remux focus-pane --pane pane:2
remux focus-panel --panel surface:7
remux close-surface --surface surface:7
```

## Move/Reorder Surfaces

```bash
remux move-surface --surface surface:7 --pane pane:2 --focus true
remux move-surface --surface surface:7 --workspace workspace:2 --window window:1 --after surface:4
remux reorder-surface --surface surface:7 --before surface:3
```

Surface identity is stable across move/reorder operations.
