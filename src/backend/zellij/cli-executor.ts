import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SessionGateway } from "../tmux/types.js";
import { parseSessions, parseTabs, parsePanes, findTabId } from "./parser.js";

const execFileAsync = promisify(execFile);

interface ZellijCliExecutorOptions {
  zellijBinary?: string;
  timeoutMs?: number;
  logger?: Pick<Console, "log" | "error">;
}

export class ZellijCliExecutor implements SessionGateway {
  private readonly binary: string;
  private readonly timeoutMs: number;
  private readonly logger?: Pick<Console, "log" | "error">;
  private readonly trace: boolean;

  /**
   * Cache paneId → sessionName, populated by listPanes() during state polling.
   * Used by pane operations that need session context (splitWindow, zoomPane).
   */
  private readonly paneSessionMap = new Map<string, string>();

  public constructor(options: ZellijCliExecutorOptions = {}) {
    this.binary = options.zellijBinary ?? "zellij";
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.logger = options.logger;
    this.trace = process.env.REMUX_TRACE_ZELLIJ === "1";
  }

  /**
   * Run a zellij command, optionally targeting a specific session.
   * --session is a global flag placed before the subcommand.
   */
  private async runZellij(
    args: string[],
    session?: string
  ): Promise<string> {
    const finalArgs = session
      ? ["--session", session, ...args]
      : args;
    try {
      if (this.trace) {
        this.logger?.log("[zellij]", this.binary, finalArgs.join(" "));
      }
      const { stdout } = await execFileAsync(this.binary, finalArgs, {
        timeout: this.timeoutMs
      });
      return stdout.trim();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(
        `zellij command failed: ${this.binary} ${finalArgs.join(" ")} => ${msg}`
      );
    }
  }

  // ── Session operations ──

  public async listSessions() {
    try {
      const output = await this.runZellij(["list-sessions", "-s", "-n"]);
      if (!output) return [];
      return parseSessions(output);
    } catch {
      return [];
    }
  }

  public async createSession(name: string): Promise<void> {
    await this.runZellij(["attach", "-cb", name]);
  }

  /**
   * No-op — Zellij has no session groups.
   * Virtual view tracking is handled at the server layer.
   */
  public async createGroupedSession(
    _name: string,
    _targetSession: string
  ): Promise<void> {}

  public async killSession(name: string): Promise<void> {
    await this.runZellij(["delete-session", "-f", name]);
  }

  public async switchClient(_session: string): Promise<void> {}

  // ── Tab/Window operations ──

  public async listWindows(session: string) {
    const json = await this.runZellij(
      ["action", "list-tabs", "--json", "--all"],
      session
    );
    return parseTabs(json);
  }

  public async newWindow(session: string): Promise<void> {
    await this.runZellij(["action", "new-tab"], session);
  }

  public async killWindow(session: string, windowIndex: number): Promise<void> {
    const json = await this.runZellij(
      ["action", "list-tabs", "--json", "--all"],
      session
    );
    const tabId = findTabId(json, windowIndex);
    if (tabId === undefined) {
      throw new Error(`No tab at position ${windowIndex} in session ${session}`);
    }
    await this.runZellij(
      ["action", "close-tab-by-id", String(tabId)],
      session
    );
  }

  public async selectWindow(session: string, windowIndex: number): Promise<void> {
    // go-to-tab uses 1-based index
    await this.runZellij(
      ["action", "go-to-tab", String(windowIndex + 1)],
      session
    );
  }

  public async renameWindow(
    session: string,
    windowIndex: number,
    newName: string
  ): Promise<void> {
    const json = await this.runZellij(
      ["action", "list-tabs", "--json", "--all"],
      session
    );
    const tabId = findTabId(json, windowIndex);
    if (tabId === undefined) {
      throw new Error(`No tab at position ${windowIndex} in session ${session}`);
    }
    await this.runZellij(
      ["action", "rename-tab-by-id", String(tabId), newName],
      session
    );
  }

  // ── Pane operations ──

  public async listPanes(session: string, windowIndex: number) {
    const tabsJson = await this.runZellij(
      ["action", "list-tabs", "--json", "--all"],
      session
    );
    const tabId = findTabId(tabsJson, windowIndex);
    if (tabId === undefined) return [];

    const panesJson = await this.runZellij(
      ["action", "list-panes", "--json", "--all"],
      session
    );
    const panes = parsePanes(panesJson, tabId);

    // Populate session cache for pane operations that lack session param
    for (const pane of panes) {
      this.paneSessionMap.set(pane.id, session);
    }

    return panes;
  }

  public async splitWindow(paneId: string, orientation: "h" | "v"): Promise<void> {
    const direction = orientation === "h" ? "right" : "down";
    const session = this.paneSessionMap.get(paneId);
    // LIMITATION: Zellij CLI has no "focus-pane-by-id" action, so new-pane
    // creates the split relative to whichever pane is currently focused in
    // the session, not necessarily the pane identified by paneId.
    await this.runZellij(["action", "new-pane", "-d", direction], session);
  }

  public async killPane(paneId: string): Promise<void> {
    const session = this.paneSessionMap.get(paneId);
    await this.runZellij(
      ["action", "close-pane", "--pane-id", paneId],
      session
    );
  }

  public async selectPane(paneId: string): Promise<void> {
    // Zellij has no direct "focus-pane-by-id" CLI action.
    // Virtual view tracking at the server layer handles pane selection.
    this.logger?.log(`[zellij] selectPane ${paneId} — virtual view`);
  }

  public async zoomPane(paneId: string): Promise<void> {
    const session = this.paneSessionMap.get(paneId);
    // LIMITATION: toggle-fullscreen acts on the focused pane, not on paneId.
    // Zellij CLI has no "focus-pane-by-id" action.
    await this.runZellij(["action", "toggle-fullscreen"], session);
  }

  public async isPaneZoomed(paneId: string): Promise<boolean> {
    const session = this.paneSessionMap.get(paneId);
    const json = await this.runZellij(
      ["action", "list-panes", "--json", "--all"],
      session
    );
    const panes: Array<{ id: number; is_plugin: boolean; is_fullscreen: boolean }> =
      JSON.parse(json);
    const numId = extractPaneNumericId(paneId);
    return panes.find((p) => !p.is_plugin && p.id === numId)?.is_fullscreen ?? false;
  }

  public async capturePane(
    paneId: string,
    _lines: number
  ): Promise<{ text: string; paneWidth: number }> {
    const session = this.paneSessionMap.get(paneId);
    const [text, json] = await Promise.all([
      this.runZellij(
        ["action", "dump-screen", "--pane-id", paneId, "--full", "--ansi"],
        session
      ),
      this.runZellij(
        ["action", "list-panes", "--json", "--all"],
        session
      )
    ]);
    const panes: Array<{ id: number; is_plugin: boolean; pane_content_columns: number }> =
      JSON.parse(json);
    const numId = extractPaneNumericId(paneId);
    const pane = panes.find((p) => !p.is_plugin && p.id === numId);
    return { text, paneWidth: pane?.pane_content_columns ?? 80 };
  }

  public async renameSession(name: string, newName: string): Promise<void> {
    await this.runZellij(["action", "rename-session", newName], name);
  }
}

function extractPaneNumericId(paneId: string): number {
  const match = paneId.match(/^(?:terminal_)?(\d+)$/);
  return match ? parseInt(match[1], 10) : -1;
}
