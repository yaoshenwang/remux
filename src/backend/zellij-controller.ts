import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// --- Zellij JSON types (from `list-tabs --json` and `list-panes --json`) ---

export interface ZellijTab {
  position: number;
  name: string;
  active: boolean;
  tab_id: number;
  is_fullscreen_active: boolean;
  is_sync_panes_active: boolean;
  are_floating_panes_visible: boolean;
  viewport_rows: number;
  viewport_columns: number;
  has_bell_notification: boolean;
}

export interface ZellijPane {
  id: number;
  is_plugin: boolean;
  is_focused: boolean;
  is_fullscreen: boolean;
  is_floating: boolean;
  is_suppressed: boolean;
  title: string;
  exited: boolean;
  pane_x: number;
  pane_y: number;
  pane_rows: number;
  pane_columns: number;
  pane_content_x: number;
  pane_content_y: number;
  pane_content_rows: number;
  pane_content_columns: number;
  cursor_coordinates_in_pane: [number, number] | null;
  terminal_command: string | null;
  pane_command: string | null;
  pane_cwd: string | null;
  plugin_url: string | null;
  tab_id: number;
  tab_position: number;
  tab_name: string;
}

// --- Remux workspace state (consumed by frontend) ---

export interface WorkspaceTab {
  index: number;
  name: string;
  active: boolean;
  isFullscreen: boolean;
  hasBell: boolean;
  panes: WorkspacePane[];
}

export interface WorkspacePane {
  id: string;
  focused: boolean;
  title: string;
  command: string | null;
  cwd: string | null;
  rows: number;
  cols: number;
  x: number;
  y: number;
}

export interface WorkspaceState {
  session: string;
  tabs: WorkspaceTab[];
  activeTabIndex: number;
}

export interface ZellijControllerOptions {
  session: string;
  zellijBin?: string;
  logger?: Pick<Console, "log" | "error">;
}

export class ZellijController {
  private session: string;
  private zellijBin: string;
  private logger: Pick<Console, "log" | "error">;

  constructor(options: ZellijControllerOptions) {
    this.session = options.session;
    this.zellijBin = options.zellijBin ?? "zellij";
    this.logger = options.logger ?? console;
  }

  // --- State queries ---

  async queryWorkspaceState(): Promise<WorkspaceState> {
    const [tabs, panes] = await Promise.all([
      this.queryTabs(),
      this.queryPanes(),
    ]);

    const terminalPanes = panes.filter((p) => !p.is_plugin && !p.is_suppressed);

    const workspaceTabs: WorkspaceTab[] = tabs.map((tab) => ({
      index: tab.position,
      name: tab.name,
      active: tab.active,
      isFullscreen: tab.is_fullscreen_active,
      hasBell: tab.has_bell_notification,
      panes: terminalPanes
        .filter((p) => p.tab_position === tab.position)
        .map((p) => ({
          id: `terminal_${p.id}`,
          focused: p.is_focused,
          title: p.title,
          command: p.pane_command ?? p.terminal_command,
          cwd: p.pane_cwd,
          rows: p.pane_content_rows,
          cols: p.pane_content_columns,
          x: p.pane_content_x,
          y: p.pane_content_y,
        })),
    }));

    const activeTab = tabs.find((t) => t.active);

    return {
      session: this.session,
      tabs: workspaceTabs,
      activeTabIndex: activeTab?.position ?? 0,
    };
  }

  async queryTabs(): Promise<ZellijTab[]> {
    const raw = await this.run(["action", "list-tabs", "--json", "--all", "--panes", "--state"]);
    return JSON.parse(raw) as ZellijTab[];
  }

  async queryPanes(): Promise<ZellijPane[]> {
    const raw = await this.run(["action", "list-panes", "--json", "--all", "--geometry", "--command", "--state"]);
    return JSON.parse(raw) as ZellijPane[];
  }

  // --- Tab operations ---

  async newTab(name?: string): Promise<void> {
    const args = ["action", "new-tab"];
    if (name) args.push("--name", name);
    await this.run(args);
  }

  async closeTab(tabIndex: number): Promise<void> {
    // Go to the tab first, then close it.
    await this.run(["action", "go-to-tab", String(tabIndex + 1)]);
    await this.run(["action", "close-tab"]);
  }

  async goToTab(tabIndex: number): Promise<void> {
    // Zellij tab indices are 1-based.
    await this.run(["action", "go-to-tab", String(tabIndex + 1)]);
  }

  async renameTab(tabIndex: number, name: string): Promise<void> {
    await this.run(["action", "go-to-tab", String(tabIndex + 1)]);
    await this.run(["action", "rename-tab", name]);
  }

  // --- Pane operations ---

  async newPane(direction: "right" | "down"): Promise<void> {
    await this.run(["action", "new-pane", "--direction", direction]);
  }

  async closePane(): Promise<void> {
    await this.run(["action", "close-pane"]);
  }

  async toggleFullscreen(): Promise<void> {
    await this.run(["action", "toggle-fullscreen"]);
  }

  // --- Inspect ---

  async dumpScreen(full = false): Promise<string> {
    const args = ["action", "dump-screen", "--ansi"];
    if (full) args.push("--full");
    return this.run(args);
  }

  // --- Session ---

  async renameSession(name: string): Promise<void> {
    await this.run(["action", "rename-session", name]);
    this.session = name;
  }

  async listSessions(): Promise<string[]> {
    const raw = await this.runGlobal(["list-sessions", "--no-formatting"]);
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }

  // --- Internal ---

  private async run(args: string[]): Promise<string> {
    try {
      const { stdout } = await execFileAsync(this.zellijBin, ["-s", this.session, ...args], {
        timeout: 5000,
      });
      return stdout;
    } catch (err) {
      this.logger.error(`zellij ${args.join(" ")} failed:`, err);
      throw err;
    }
  }

  private async runGlobal(args: string[]): Promise<string> {
    try {
      const { stdout } = await execFileAsync(this.zellijBin, args, { timeout: 5000 });
      return stdout;
    } catch (err) {
      this.logger.error(`zellij ${args.join(" ")} failed:`, err);
      throw err;
    }
  }
}
