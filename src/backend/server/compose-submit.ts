import path from "node:path";
import type { ClientView, WorkspaceSnapshot } from "../../shared/protocol.js";

export const CODEX_COMPOSE_SUBMIT_DELAY_MS = 150;

export interface ComposeRuntimeWriter {
  write(data: string): void;
}

interface SendComposeToRuntimeOptions {
  runtime: ComposeRuntimeWriter;
  text: string;
  paneCommand?: string | null;
  scheduleDelayedWrite?: (callback: () => void, delayMs: number) => void;
  shouldSendDelayedEnter?: () => boolean;
}

const normalizeCommand = (command?: string | null): string => {
  const executable = command?.trim().split(/\s+/)[0];
  if (!executable) {
    return "";
  }
  return path.basename(executable).replace(/\.exe$/i, "").toLowerCase();
};

const isCodexComposeRuntime = (paneCommand?: string | null): boolean =>
  normalizeCommand(paneCommand) === "codex";

export const resolvePaneCommandForView = (
  snapshot: WorkspaceSnapshot | undefined,
  view: ClientView | undefined
): string | null => {
  if (!snapshot || !view) {
    return null;
  }

  const session = snapshot.sessions.find((candidate) => candidate.name === view.sessionName);
  const tab = session?.tabs.find((candidate) => candidate.index === view.tabIndex);
  const pane = tab?.panes.find((candidate) => candidate.id === view.paneId);
  return pane?.currentCommand ?? null;
};

export const sendComposeToRuntime = ({
  runtime,
  text,
  paneCommand,
  scheduleDelayedWrite = (callback, delayMs) => {
    setTimeout(callback, delayMs);
  },
  shouldSendDelayedEnter = () => true
}: SendComposeToRuntimeOptions): void => {
  if (!text) {
    return;
  }

  if (!isCodexComposeRuntime(paneCommand)) {
    runtime.write(`${text}\r`);
    return;
  }

  // Codex detects rapid text+Enter bursts as paste, which turns Enter into a newline.
  runtime.write(text);
  scheduleDelayedWrite(() => {
    if (!shouldSendDelayedEnter()) {
      return;
    }
    runtime.write("\r");
  }, CODEX_COMPOSE_SUBMIT_DELAY_MS);
};
