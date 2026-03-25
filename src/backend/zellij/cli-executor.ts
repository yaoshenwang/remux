import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import * as pty from "node-pty";
import { promisify } from "node:util";
import type { MultiplexerBackend } from "../multiplexer/types.js";
import type { BackendCapabilities } from "../../shared/protocol.js";
import { parseSessions, parseTabs, parsePanes, findTabId, type ZellijPaneJson } from "./parser.js";

const execFileAsync = promisify(execFile);

/** Strip ANSI escape sequences from CLI output. */
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

interface ZellijCliExecutorOptions {
  zellijBinary?: string;
  timeoutMs?: number;
  logger?: Pick<Console, "log" | "error">;
  /** Path to remux-focus.wasm plugin for focus-pane-by-id support. */
  focusPluginPath?: string;
  /** Isolated zellij socket dir. */
  socketDir?: string;
}

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const getDefaultShellCommand = (): string[] => {
  const shell = process.env.SHELL?.trim();
  return shell ? [shell] : ["sh"];
};

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
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly socketDir?: string;
  private createBackgroundSupported: boolean | null = null;
  private commandQueue: Promise<void> = Promise.resolve();

  /**
   * Cache paneId → sessionName, populated by listPanes() during state polling.
   * Used by pane operations that need session context (splitPane, toggleFullscreen).
   */
  private readonly paneSessionMap = new Map<string, string>();
  private readonly paneTabMap = new Map<string, number>();
  /** Path to remux-focus.wasm for focus-pane-by-id via plugin pipe. */
  private readonly focusPluginPath?: string;

  public constructor(options: ZellijCliExecutorOptions = {}) {
    this.binary = options.zellijBinary ?? "zellij";
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.logger = options.logger;
    this.trace = process.env.REMUX_TRACE_ZELLIJ === "1";
    this.focusPluginPath = options.focusPluginPath;
    this.socketDir = options.socketDir;
    this.baseEnv = {
      ...process.env,
      ...(this.socketDir ? { ZELLIJ_SOCKET_DIR: this.socketDir } : {})
    };
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
    return this.enqueueCommand(() => this.runZellijImmediate(args, session, options));
  }

  private async runZellijImmediate(
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
      execOpts.env = { ...this.baseEnv, ...options?.env };
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
      const sessions = await this.listSessionSummaries();
      const tabCounts = await Promise.all(
        sessions.map(async (session) => {
          if (!(await this.sessionExistsInSocketDir(session.name))) {
            return { session, tabCount: 0, include: false };
          }
          try {
            const tabs = await this.listTabs(session.name);
            return { session, tabCount: tabs.length, include: true };
          } catch (error) {
            if (isStaleSessionError(error)) {
              await this.cleanupStaleSession(session.name);
              return { session, tabCount: 0, include: false };
            }
            return { session, tabCount: 0, include: true };
          }
        })
      );
      return tabCounts
        .filter((entry) => entry.include)
        .map(({ session, tabCount }) => ({
          ...session,
          tabCount
        }));
    } catch {
      return [];
    }
  }

  public async createSession(name: string): Promise<void> {
    // Guard: skip if session already exists.
    const sessions = await this.listSessionSummaries();
    if (await this.sessionExistsInSocketDir(name) && sessions.some((s) => s.name === name)) {
      return;
    }
    await this.spawnSessionBootstrap(name);
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
    await this.runZellij(["action", "new-tab", "--", ...getDefaultShellCommand()], session);
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
      this.paneTabMap.set(pane.id, tabIndex);
    }

    return panes;
  }

  public async splitPane(paneId: string, direction: "right" | "down"): Promise<void> {
    const session = this.paneSessionMap.get(paneId);
    if (!session) {
      throw new Error(`No session mapped for pane ${paneId}`);
    }
    await this.focusPane(paneId);
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
    if (!session) return;
    await this.focusPaneViaGeometry(paneId, session);
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
    options?: { lines?: number }
  ): Promise<{ text: string; paneWidth: number; isApproximate: boolean }> {
    const session = this.paneSessionMap.get(paneId);
    const [rawText, json] = await Promise.all([
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
    // dump-screen --full returns the entire screen; trim to requested lines
    let text = rawText;
    if (options?.lines && options.lines > 0) {
      const allLines = text.split("\n");
      if (allLines.length > options.lines) {
        text = allLines.slice(-options.lines).join("\n");
      }
    }
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

  private async spawnSessionBootstrap(name: string): Promise<void> {
    try {
      if (await this.tryCreateSessionInBackground(name)) {
        return;
      }
    } catch (error) {
      this.logger?.error?.(
        `[zellij] background session bootstrap failed for '${name}', falling back to PTY bootstrap: ${String(error)}`
      );
    }

    await new Promise<void>((resolve, reject) => {
      const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
      const args = process.platform === "win32"
        ? ["/c", this.binary, "attach", "-c", name]
        : ["-lc", `exec ${shellQuote(this.binary)} attach -c ${shellQuote(name)}`];
      const client = pty.spawn(shell, args, {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd: process.cwd(),
        env: { ...this.baseEnv, REMUX: "1" }
      });
      let settled = false;

      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        client.kill();
        if (error) {
          reject(error);
          return;
        }
        resolve();
      };

      client.onExit(({ exitCode }) => {
        if (settled) return;
        finish(
          new Error(
            `zellij session bootstrap exited before session became ready: `
            + `code=${exitCode}`
          )
        );
      });

      const deadline = Date.now() + this.timeoutMs;
      const poll = async (): Promise<void> => {
        while (!settled && Date.now() < deadline) {
          try {
            const sessions = await this.listSessionSummariesImmediate();
            if (sessions.some((session) => session.name === name)) {
              finish();
              return;
            }
          } catch {
            // The bootstrap process may win the race to create the session;
            // keep polling until timeout before surfacing an error.
          }
          await sleep(100);
        }
        if (!settled) {
          finish(new Error(`timed out waiting for zellij session '${name}'`));
        }
      };

      void poll();
    });
  }

  private async tryCreateSessionInBackground(name: string): Promise<boolean> {
    if (this.createBackgroundSupported === false) {
      return false;
    }

    try {
      await this.runZellij(["attach", "-b", name]);
      this.createBackgroundSupported = true;
    } catch (error) {
      if (!isUnsupportedCreateBackgroundError(error)) {
        throw error;
      }
      this.createBackgroundSupported = false;
      return false;
    }

    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      const sessions = await this.listSessionSummariesImmediate();
      if (sessions.some((session) => session.name === name)) {
        return true;
      }
      await sleep(100);
    }
    throw new Error(`timed out waiting for zellij session '${name}'`);
  }

  private async listSessionSummaries() {
    try {
      const output = await this.runZellij(["list-sessions", "-s", "-n"]);
      return output ? parseSessions(output) : [];
    } catch {
      return [];
    }
  }

  private async listSessionSummariesImmediate() {
    try {
      const output = await this.runZellijImmediate(["list-sessions", "-s", "-n"]);
      return output ? parseSessions(output) : [];
    } catch {
      return [];
    }
  }

  private async sessionExistsInSocketDir(name: string): Promise<boolean> {
    if (!this.socketDir) {
      return true;
    }

    try {
      const contractDirs = await fs.promises.readdir(this.socketDir, {
        withFileTypes: true
      });
      return contractDirs
        .filter((entry) => entry.isDirectory() && entry.name.startsWith("contract_version_"))
        .some((entry) => {
          const sessionSocketPath = path.join(this.socketDir as string, entry.name, name);
          return fs.existsSync(sessionSocketPath);
        });
    } catch {
      return false;
    }
  }

  private async cleanupStaleSession(name: string): Promise<void> {
    try {
      await this.killSession(name);
      this.logger?.log?.(`[zellij] cleaned stale session '${name}'`);
    } catch (error) {
      this.logger?.error?.(`[zellij] failed to clean stale session '${name}': ${String(error)}`);
    }
  }

  private async focusPaneViaGeometry(paneId: string, session: string): Promise<void> {
    const targetId = extractPaneNumericId(paneId);
    if (targetId < 0) return;

    const targetTabIndex = this.paneTabMap.get(paneId);
    if (targetTabIndex !== undefined) {
      await this.selectTab(session, targetTabIndex);
    }
    await this.runZellij(["action", "hide-floating-panes"], session).catch(() => {});

    const panes = await this.listRawPanes(session);
    const target = panes.find((pane) => isTerminalPane(pane) && pane.id === targetId);
    if (!target) return;

    const panesInTab = panes.filter(
      (pane) => isTerminalPane(pane) && pane.tab_id === target.tab_id
    );
    let current = panesInTab.find((pane) => pane.is_focused) ?? panesInTab[0];
    if (!current || current.id === target.id) {
      return;
    }

    for (let i = 0; i < panesInTab.length + 2; i += 1) {
      const step = chooseFocusStep(current, target, panesInTab);
      if (!step) {
        break;
      }
      await this.runZellij(["action", "move-focus", step.direction], session);
      current = step.pane;
      if (current.id === target.id) {
        return;
      }
    }

    await this.focusPaneViaPlugin(paneId, session);
  }

  private async listRawPanes(session: string): Promise<ZellijPaneJson[]> {
    const json = await this.runZellij(
      ["action", "list-panes", "--json", "--all"],
      session
    );
    let panes: ZellijPaneJson[];
    try {
      panes = JSON.parse(json);
    } catch {
      return [];
    }
    return Array.isArray(panes) ? panes : [];
  }

  private async enqueueCommand<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.commandQueue.then(fn, fn);
    this.commandQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
}

function extractPaneNumericId(paneId: string): number {
  const match = paneId.match(/^(?:terminal_)?(\d+)$/);
  return match ? parseInt(match[1], 10) : -1;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function isStaleSessionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("There is no active session!")
    || message.includes("Session not found")
    || message.includes("No session named");
}

function isUnsupportedCreateBackgroundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("unexpected argument '-b'")
    || message.includes("unexpected argument '--create-background'")
    || message.includes("Found argument '-b' which wasn't expected");
}

function isTerminalPane(pane: ZellijPaneJson): boolean {
  return !pane.is_plugin && pane.is_selectable;
}

function chooseFocusStep(
  current: ZellijPaneJson,
  target: ZellijPaneJson,
  panes: ZellijPaneJson[]
): { direction: "left" | "right" | "up" | "down"; pane: ZellijPaneJson } | null {
  const candidates = [
    pickDirectionalNeighbor(current, panes, "left"),
    pickDirectionalNeighbor(current, panes, "right"),
    pickDirectionalNeighbor(current, panes, "up"),
    pickDirectionalNeighbor(current, panes, "down")
  ].filter((candidate): candidate is { direction: "left" | "right" | "up" | "down"; pane: ZellijPaneJson } => candidate !== null);

  if (candidates.length === 0) {
    return null;
  }

  return candidates
    .map((candidate) => ({
      ...candidate,
      score: focusDistance(candidate.pane, target)
    }))
    .sort((a, b) => a.score - b.score)[0];
}

function pickDirectionalNeighbor(
  current: ZellijPaneJson,
  panes: ZellijPaneJson[],
  direction: "left" | "right" | "up" | "down"
): { direction: "left" | "right" | "up" | "down"; pane: ZellijPaneJson } | null {
  const currentRect = paneRect(current);
  const matches = panes
    .filter((pane) => pane.id !== current.id)
    .map((pane) => ({ pane, rect: paneRect(pane) }))
    .filter(({ rect }) => {
      if (direction === "left") {
        return rect.right <= currentRect.left && overlap(currentRect.top, currentRect.bottom, rect.top, rect.bottom) > 0;
      }
      if (direction === "right") {
        return rect.left >= currentRect.right && overlap(currentRect.top, currentRect.bottom, rect.top, rect.bottom) > 0;
      }
      if (direction === "up") {
        return rect.bottom <= currentRect.top && overlap(currentRect.left, currentRect.right, rect.left, rect.right) > 0;
      }
      return rect.top >= currentRect.bottom && overlap(currentRect.left, currentRect.right, rect.left, rect.right) > 0;
    })
    .sort((a, b) => directionalDistance(currentRect, a.rect, direction) - directionalDistance(currentRect, b.rect, direction));

  const selected = matches[0]?.pane;
  return selected ? { direction, pane: selected } : null;
}

function paneRect(pane: ZellijPaneJson): { left: number; right: number; top: number; bottom: number } {
  return {
    left: pane.pane_x,
    right: pane.pane_x + pane.pane_columns,
    top: pane.pane_y,
    bottom: pane.pane_y + pane.pane_rows
  };
}

function overlap(a1: number, a2: number, b1: number, b2: number): number {
  return Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));
}

function directionalDistance(
  current: { left: number; right: number; top: number; bottom: number },
  next: { left: number; right: number; top: number; bottom: number },
  direction: "left" | "right" | "up" | "down"
): number {
  if (direction === "left") return current.left - next.right;
  if (direction === "right") return next.left - current.right;
  if (direction === "up") return current.top - next.bottom;
  return next.top - current.bottom;
}

function focusDistance(pane: ZellijPaneJson, target: ZellijPaneJson): number {
  const paneCenterX = pane.pane_x + pane.pane_columns / 2;
  const paneCenterY = pane.pane_y + pane.pane_rows / 2;
  const targetCenterX = target.pane_x + target.pane_columns / 2;
  const targetCenterY = target.pane_y + target.pane_rows / 2;
  return Math.abs(targetCenterX - paneCenterX) + Math.abs(targetCenterY - paneCenterY);
}
