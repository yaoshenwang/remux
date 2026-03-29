import { z } from "zod";
import type { WebSocket } from "ws";
import type {
  ControlClientMessage,
  ControlServerMessage,
  RuntimeSnapshot,
} from "../../shared/protocol.js";

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const clientDiagnosticSampleSchema = z.object({
  theme: z.enum(["dark", "light"]).optional(),
  viewMode: z.enum(["inspect", "terminal"]).optional(),
  terminalViewState: z.enum(["idle", "connecting", "restoring", "live", "stale"]).optional(),
  viewRevision: z.number().int().min(1).optional(),
  terminalEpoch: z.number().int().min(1).optional(),
  frontendCols: z.number().optional(),
  frontendRows: z.number().optional(),
  backendCols: z.number().optional(),
  backendRows: z.number().optional(),
  hostWidth: z.number().optional(),
  hostHeight: z.number().optional(),
  screenWidth: z.number().optional(),
  screenOffsetLeft: z.number().optional(),
  screenOffsetTop: z.number().optional(),
  viewportWidth: z.number().optional(),
  viewportOffsetLeft: z.number().optional(),
  contrastRatio: z.number().optional(),
  bufferLineCount: z.number().optional(),
  lastResizeSource: z.string().optional(),
});

const clientDiagnosticDetailsSchema = z.object({
  issue: z.enum(["layout_misalignment", "color_whiteout", "width_mismatch", "history_gap"]),
  severity: z.enum(["warn", "error"]),
  status: z.enum(["open", "resolved"]),
  summary: z.string(),
  sample: clientDiagnosticSampleSchema,
  recentActions: z.array(z.object({
    at: z.string(),
    type: z.string(),
    label: z.string(),
    detail: z.string().optional(),
  })),
  recentSamples: z.array(clientDiagnosticSampleSchema).optional(),
});

const controlClientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("auth"),
    token: z.string().optional(),
    password: z.string().optional(),
    clientId: z.string().optional(),
    transportMode: z.enum(["raw", "patch"]).optional(),
    viewRevision: z.number().int().min(1).optional(),
    baseRevision: z.number().int().min(0).optional(),
    session: z.string().optional(),
    tabIndex: z.number().int().min(0).optional(),
    paneId: z.string().optional(),
    cols: z.number().int().min(2).optional(),
    rows: z.number().int().min(2).optional()
  }),
  z.object({ type: z.literal("select_session"), session: z.string() }),
  z.object({ type: z.literal("new_session"), name: z.string() }),
  z.object({ type: z.literal("close_session"), session: z.string() }),
  z.object({ type: z.literal("new_tab"), session: z.string() }),
  z.object({ type: z.literal("select_tab"), session: z.string(), tabIndex: z.number() }),
  z.object({ type: z.literal("close_tab"), session: z.string(), tabIndex: z.number() }),
  z.object({ type: z.literal("select_pane"), paneId: z.string() }),
  z.object({ type: z.literal("split_pane"), paneId: z.string(), direction: z.enum(["right", "down"]) }),
  z.object({ type: z.literal("close_pane"), paneId: z.string() }),
  z.object({ type: z.literal("toggle_fullscreen"), paneId: z.string() }),
  z.object({ type: z.literal("capture_scrollback"), paneId: z.string(), lines: z.number().optional() }), // Legacy wire name — kept for backward compat
  z.object({ type: z.literal("capture_tab_history"), session: z.string().optional(), tabIndex: z.number(), lines: z.number().optional() }),
  z.object({
    type: z.literal("report_client_diagnostic"),
    session: z.string().optional(),
    tabIndex: z.number().int().min(0).optional(),
    paneId: z.string().optional(),
    viewRevision: z.number().int().min(1).optional(),
    diagnostic: clientDiagnosticDetailsSchema,
  }),
  z.object({ type: z.literal("send_compose"), text: z.string() }),
  z.object({ type: z.literal("rename_session"), session: z.string(), newName: z.string() }),
  z.object({ type: z.literal("rename_tab"), session: z.string(), tabIndex: z.number(), newName: z.string() }),
  z.object({ type: z.literal("set_follow_focus"), follow: z.boolean() })
]);

export const parseClientMessage = (raw: string): ControlClientMessage | null => {
  try {
    const parsed = JSON.parse(raw) as unknown;
    const result = controlClientMessageSchema.safeParse(parsed);
    if (!result.success) {
      return null;
    }
    return result.data as ControlClientMessage;
  } catch {
    return null;
  }
};

export const sendJson = (socket: WebSocket, payload: ControlServerMessage): void => {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
};

export const summarizeClientMessage = (message: ControlClientMessage): string => {
  if (message.type === "auth") {
    return JSON.stringify({
      type: message.type,
      tokenPresent: Boolean(message.token),
      passwordPresent: Boolean(message.password),
      clientIdPresent: Boolean(message.clientId),
      transportMode: message.transportMode,
      viewRevision: message.viewRevision,
      baseRevision: message.baseRevision,
      cols: message.cols,
      rows: message.rows
    });
  }
  if (message.type === "send_compose") {
    return JSON.stringify({
      type: message.type,
      textLength: message.text.length
    });
  }
  if (message.type === "report_client_diagnostic") {
    return JSON.stringify({
      type: message.type,
      viewRevision: message.viewRevision,
      issue: message.diagnostic.issue,
      status: message.diagnostic.status,
      actionCount: message.diagnostic.recentActions.length,
    });
  }
  return JSON.stringify({ type: message.type });
};

export const summarizeState = (state: RuntimeSnapshot): string => {
  const sessions = state.sessions.map((session) => {
    const activeTab =
      session.tabs.find((tab) => tab.active) ?? session.tabs[0];
    const activePane = activeTab?.panes.find((pane) => pane.active) ?? activeTab?.panes[0];
    return `${session.name}[attached=${session.attached}]`
      + `{tab=${activeTab ? `${activeTab.index}:${activeTab.name}` : "none"},`
      + `pane=${activePane ? `${activePane.id}:zoom=${activePane.zoomed}` : "none"},`
      + `tabs=${session.tabs.length}}`;
  });
  return `capturedAt=${state.capturedAt}; sessions=${sessions.join(" | ")}`;
};

export const extractTerminalDimensions = (
  message: { cols?: number; rows?: number }
): { cols: number; rows: number } | null => {
  if (
    typeof message.cols !== "number" ||
    typeof message.rows !== "number" ||
    !Number.isFinite(message.cols) ||
    !Number.isFinite(message.rows) ||
    message.cols < 2 ||
    message.rows < 2
  ) {
    return null;
  }

  return {
    cols: Math.floor(message.cols),
    rows: Math.floor(message.rows)
  };
};

export { isObject };
