import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { MultiplexerBackend } from "../multiplexer/types.js";
import type { BackendCapabilities } from "../../shared/protocol.js";
import { parseSessions, parseTabs, parsePanes, findTabId } from "./parser.js";

const execFileAsync = promisify(execFile);

/** Strip ANSI escape sequences from CLI output. */
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

interface ZellijCliExecutorOptions {
  zellijBinary?: string;
  timeoutMs?: number;
  logger?: Pick<Console, "log" | "error">;
  /** Path to remux-focus.wasm plugin for focus-pane-by-id support. */
  focusPluginPath?: string;
}

export class ZellijCliExecutor implements MultiplexerBackend {
  public readonly kind = "zellij" as const;
  public readonly capabilities: BackendCapabilities = {
    supportsPaneFocusById: true,
    supportsTabRename: true,
    supportsSessionRename: true,
    supportsPreciseScrollback: false,
    supportsFloatingPanes: true,
    supportsFullscreenPane: true,
  };

  private readonly binary: string;
  private readonly timeoutMs: number;
  private readonly logger?: Pick<Console, "log" | "error">;
  private readonly trace: boolean;

  /**
   * Cache paneId → sessionName, populated by listPanes() during state polling.
   * Used by pane operations that need session context (splitPane, toggleFullscreen).
   */
  private readonly paneSessionMap = new Map<string, string>();
  /** Path to remux-focus.wasm for focus-pane-by-id via plugin pipe. */
  private readonly focusPluginPath?: string;

  public constructor(options: ZellijCliExecutorOptions = {}) {
    this.binary = options.zellijBinary ?? "zellij";
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.logger = options.logger;
    this.trace = process.env.REMUX_TRACE_ZELLIJ === "1";
    this.focusPluginPath = options.focusPluginPath;
  }

  /**
   * Run a zellij command, optionally targeting a specific session.
   * --session is a global flag placed before the subcommand.
   */
  private async runZellij(
    args: string[],
    session?: string,
    options?: { raw?: boolean; env?: Record<string, string> }
  ): Promise<string> {
    const finalArgs = session
      ? ["--session", session, ...args]
      : args;
    try {
      if (this.trace) {
        this.logger?.log("[zellij]", this.binary, finalArgs.join(" "));
      }
      const execOpts: { timeout: number; env?: NodeJS.ProcessEnv } = {
        timeout: this.timeoutMs
      };
      if (options?.env) {
        execOpts.env = { ...process.env, ...options.env };
      }
      const { stdout } = await execFileAsync(this.binary, finalArgs, execOpts);
      // Strip ANSI escape codes unless raw mode requested (e.g. dump-screen --ansi)
      // Raw mode preserves exact output including leading/trailing whitespace
      return options?.raw ? stdout : stripAnsi(stdout).trim();
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
    // Guard: skip if session already exists (attach -cb blocks on existing sessions)
    const sessions = await this.listSessions();
    if (sessions.some((s) => s.name === name)) return;
    // Set REMUX=1 so the pane's shell profile can detect it's inside remux
    // and skip launching other multiplexers (e.g. tmux auto-launchers).
    await this.runZellij(["attach", "-cb", name], undefined, {
      env: { REMUX: "1" }
    });
  }

  public async killSession(name: string): Promise<void> {
    await this.runZellij(["delete-session", "-f", name]);
  }

  public async renameSession(name: string, newName: string): Promise<void> {
    await this.runZellij(["action", "rename-session", newName], name);
  }

  // ── Tab operations ──

  public async listTabs(session: string) {
    const json = await this.runZellij(
      ["action", "list-tabs", "--json", "--all"],
      session
    );
    return parseTabs(json);
  }

  public async newTab(session: string): Promise<void> {
    await this.runZellij(["action", "new-tab"], session);
  }

  public async closeTab(session: string, tabIndex: number): Promise<void> {
    const json = await this.runZellij(
      ["action", "list-tabs", "--json", "--all"],
      session
    );
    const tabId = findTabId(json, tabIndex);
    if (tabId === undefined) {
      throw new Error(`No tab at position ${tabIndex} in session ${session}`);
    }
    await this.runZellij(
      ["action", "close-tab-by-id", String(tabId)],
      session
    );
  }

  public async selectTab(session: string, tabIndex: number): Promise<void> {
    // go-to-tab uses 1-based index
    await this.runZellij(
      ["action", "go-to-tab", String(tabIndex + 1)],
      session
    );
  }

  public async renameTab(
    session: string,
    tabIndex: number,
    newName: string
  ): Promise<void> {
    const json = await this.runZellij(
      ["action", "list-tabs", "--json", "--all"],
      session
    );
    const tabId = findTabId(json, tabIndex);
    if (tabId === undefined) {
      throw new Error(`No tab at position ${tabIndex} in session ${session}`);
    }
    await this.runZellij(
      ["action", "rename-tab-by-id", String(tabId), newName],
      session
    );
  }

  // ── Pane operations ──

  public async listPanes(session: string, tabIndex: number) {
    const tabsJson = await this.runZellij(
      ["action", "list-tabs", "--json", "--all"],
      session
    );
    const tabId = findTabId(tabsJson, tabIndex);
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

  public async splitPane(paneId: string, direction: "right" | "down"): Promise<void> {
    const session = this.paneSessionMap.get(paneId);
    await this.focusPaneViaPlugin(paneId, session);
    await this.runZellij(["action", "new-pane", "-d", direction], session);
  }

  public async closePane(paneId: string): Promise<void> {
    const session = this.paneSessionMap.get(paneId);
    await this.runZellij(
      ["action", "close-pane", "--pane-id", paneId],
      session
    );
  }

  public async focusPane(paneId: string): Promise<void> {
    const session = this.paneSessionMap.get(paneId);
    await this.focusPaneViaPlugin(paneId, session);
  }

  public async toggleFullscreen(paneId: string): Promise<void> {
    const session = this.paneSessionMap.get(paneId);
    // toggle-fullscreen supports --pane-id directly, no need to focus first
    await this.runZellij(
      ["action", "toggle-fullscreen", "--pane-id", paneId],
      session
    );
  }

  public async isPaneFullscreen(paneId: string): Promise<boolean> {
    const session = this.paneSessionMap.get(paneId);
    const json = await this.runZellij(
      ["action", "list-panes", "--json", "--all"],
      session
    );
    let panes: Array<{ id: number; is_plugin: boolean; is_fullscreen: boolean }>;
    try { panes = JSON.parse(json); } catch { return false; }
    if (!Array.isArray(panes)) return false;
    const numId = extractPaneNumericId(paneId);
    return panes.find((p) => !p.is_plugin && p.id === numId)?.is_fullscreen ?? false;
  }

  public async capturePane(
    paneId: string,
    _options?: { lines?: number }
  ): Promise<{ text: string; paneWidth: number; isApproximate: boolean }> {
    const session = this.paneSessionMap.get(paneId);
    const [text, json] = await Promise.all([
      this.runZellij(
        ["action", "dump-screen", "--pane-id", paneId, "--full", "--ansi"],
        session,
        { raw: true }
      ),
      this.runZellij(
        ["action", "list-panes", "--json", "--all"],
        session
      )
    ]);
    let panes: Array<{ id: number; is_plugin: boolean; pane_content_columns: number }>;
    try { panes = JSON.parse(json); } catch { return { text, paneWidth: 80, isApproximate: true }; }
    if (!Array.isArray(panes)) return { text, paneWidth: 80, isApproximate: true };
    const numId = extractPaneNumericId(paneId);
    const pane = panes.find((p) => !p.is_plugin && p.id === numId);
    return { text, paneWidth: pane?.pane_content_columns ?? 80, isApproximate: true };
  }

  // ── Focus plugin helpers ──

  /**
   * Focus a terminal pane by ID using the remux-focus WASM plugin.
   * Uses `zellij pipe --plugin file:...` which auto-launches the plugin
   * if it's not already running (without creating a visible pane).
   * Falls back silently if the plugin path is not configured.
   */
  private async focusPaneViaPlugin(
    paneId: string,
    session?: string
  ): Promise<void> {
    if (!this.focusPluginPath) return;

    const numId = extractPaneNumericId(paneId);
    if (numId < 0) return;

    try {
      await this.runZellij(
        ["pipe", "--plugin", `file:${this.focusPluginPath}`, "--name", "focus", "--", String(numId)],
        session
      );
    } catch (err) {
      this.logger?.error(`[zellij] focus pipe failed: ${err}`);
    }
  }
}

function extractPaneNumericId(paneId: string): number {
  const match = paneId.match(/^(?:terminal_)?(\d+)$/);
  return match ? parseInt(match[1], 10) : -1;
}
