import type {
  SessionSummary,
  WindowState,
  PaneState
} from "../../shared/protocol.js";

// ── Raw JSON shapes from `zellij action list-tabs --json --all` ──

export interface ZellijTabJson {
  position: number;
  name: string;
  active: boolean;
  is_fullscreen_active: boolean;
  is_sync_panes_active: boolean;
  are_floating_panes_visible: boolean;
  viewport_rows: number;
  viewport_columns: number;
  display_area_rows: number;
  display_area_columns: number;
  selectable_tiled_panes_count: number;
  selectable_floating_panes_count: number;
  tab_id: number;
}

// ── Raw JSON shape from `zellij action list-panes --json --all` ──

export interface ZellijPaneJson {
  id: number;
  is_plugin: boolean;
  is_focused: boolean;
  is_fullscreen: boolean;
  is_floating: boolean;
  is_suppressed: boolean;
  title: string;
  exited: boolean;
  exit_status: number | null;
  is_held: boolean;
  pane_x: number;
  pane_y: number;
  pane_rows: number;
  pane_columns: number;
  pane_content_rows: number;
  pane_content_columns: number;
  cursor_coordinates_in_pane: [number, number] | null;
  terminal_command: string | null;
  plugin_url: string | null;
  is_selectable: boolean;
  tab_id: number;
  tab_position: number;
  tab_name: string;
  pane_cwd?: string;
  pane_command?: string;
}

// ── Subscribe event shape ──

export interface ZellijSubscribeEvent {
  event: "pane_update";
  is_initial: boolean;
  pane_id: string;
  scrollback: string[] | null;
  viewport: string[];
}

// ── Parsers ──

/**
 * Parse `zellij list-sessions -s -n` output.
 * Each non-empty line is a session name. Zellij doesn't expose
 * attached/window-count in this format, so we default those.
 */
export function parseSessions(output: string): SessionSummary[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((name) => ({ name, attached: false, windows: 0 }));
}

/**
 * Parse `zellij action list-tabs --json --all` output into WindowState[].
 * Zellij "tab" maps to our "window" concept.
 */
export function parseTabs(json: string): Omit<WindowState, "panes">[] {
  const tabs: ZellijTabJson[] = JSON.parse(json);
  return tabs.map((tab) => ({
    index: tab.position,
    name: tab.name,
    active: tab.active,
    paneCount: tab.selectable_tiled_panes_count + tab.selectable_floating_panes_count
  }));
}

/**
 * Parse `zellij action list-panes --json --all` output into PaneState[].
 * Filters to terminal (non-plugin) selectable panes and maps to our model.
 */
export function parsePanes(
  json: string,
  tabId: number
): PaneState[] {
  const panes: ZellijPaneJson[] = JSON.parse(json);
  return panes
    .filter((p) => !p.is_plugin && p.is_selectable && p.tab_id === tabId)
    .map((p, idx) => ({
      index: idx,
      id: `terminal_${p.id}`,
      currentCommand: p.pane_command ?? p.terminal_command ?? p.title ?? "",
      active: p.is_focused,
      width: p.pane_content_columns,
      height: p.pane_content_rows,
      zoomed: p.is_fullscreen,
      currentPath: p.pane_cwd ?? ""
    }));
}

/**
 * Find the tab_id for a given tab position (0-based index).
 */
export function findTabId(
  json: string,
  position: number
): number | undefined {
  const tabs: ZellijTabJson[] = JSON.parse(json);
  return tabs.find((t) => t.position === position)?.tab_id;
}
