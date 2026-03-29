import path from "node:path";
import type { ClientView, WorkspaceSnapshot } from "../../shared/protocol.js";

export const CODEX_COMPOSE_SUBMIT_DELAY_MS = 150;

export type ComposeSubmitMode = "auto" | "immediate" | "delayed";

export interface ComposeRuntimeWriter {
  write(data: string): void;
}

interface SendComposeToRuntimeOptions {
  logger?: Pick<Console, "error">;
  runtime: ComposeRuntimeWriter;
  text: string;
  paneCommand?: string | null;
  submitMode?: ComposeSubmitMode;
  scheduleDelayedWrite?: (callback: () => void, delayMs: number) => void;
  shouldSendDelayedEnter?: () => boolean;
}

const composeQueueByRuntime = new WeakMap<ComposeRuntimeWriter, Promise<void>>();

const normalizeCommand = (command?: string | null): string => {
  const executable = command?.trim().split(/\s+/)[0];
  if (!executable) {
    return "";
  }
  return path.basename(executable).replace(/\.exe$/i, "").toLowerCase();
};

const isCodexComposeRuntime = (paneCommand?: string | null): boolean =>
  normalizeCommand(paneCommand) === "codex";

const resolveSubmitMode = (
  submitMode: ComposeSubmitMode,
  paneCommand?: string | null,
): Exclude<ComposeSubmitMode, "auto"> => {
  if (submitMode === "immediate" || submitMode === "delayed") {
    return submitMode;
  }
  return isCodexComposeRuntime(paneCommand) ? "delayed" : "immediate";
};

const waitForDelayedWrite = (
  scheduleDelayedWrite: (callback: () => void, delayMs: number) => void,
): Promise<void> =>
  new Promise((resolve) => {
    scheduleDelayedWrite(resolve, CODEX_COMPOSE_SUBMIT_DELAY_MS);
  });

export const resolvePaneCommandForView = (
  snapshot: WorkspaceSnapshot | undefined,
  view: ClientView | undefined
): string | null => {
  if (!snapshot || !view) {
    return null;
  }

  const session = snapshot.sessions.find((candidate) => candidate.name === view.sessionName);
  const tab = session?.tabs.find((candidate) => candidate.index === view.tabIndex);
  const pane = view.paneId
    ? tab?.panes.find((candidate) => candidate.id === view.paneId)
    : (tab?.panes.find((candidate) => candidate.active) ?? tab?.panes[0]);
  return pane?.currentCommand ?? null;
};

export const sendComposeToRuntime = ({
  logger = console,
  runtime,
  text,
  paneCommand,
  submitMode = "auto",
  scheduleDelayedWrite = (callback, delayMs) => {
    setTimeout(callback, delayMs);
  },
  shouldSendDelayedEnter = () => true
}: SendComposeToRuntimeOptions): void => {
  if (!text) {
    return;
  }

  const run = async (): Promise<void> => {
    if (resolveSubmitMode(submitMode, paneCommand) === "immediate") {
      runtime.write(`${text}\r`);
      return;
    }

    // Codex detects rapid text+Enter bursts as paste, which turns Enter into a newline.
    runtime.write(text);
    await waitForDelayedWrite(scheduleDelayedWrite);
    if (!shouldSendDelayedEnter()) {
      return;
    }
    runtime.write("\r");
  };

  const previous = composeQueueByRuntime.get(runtime) ?? Promise.resolve();
  const next = previous.then(run, run).catch((error) => {
    logger.error("compose queue error:", error);
  });
  composeQueueByRuntime.set(runtime, next);
  void next.finally(() => {
    if (composeQueueByRuntime.get(runtime) === next) {
      composeQueueByRuntime.delete(runtime);
    }
  });
};
