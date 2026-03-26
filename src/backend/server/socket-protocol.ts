import { z } from "zod";
import type { WebSocket } from "ws";
import type {
  ControlClientMessage,
  ControlServerMessage,
  WorkspaceSnapshot,
} from "../../shared/protocol.js";

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const controlClientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("auth"),
    token: z.string().optional(),
    password: z.string().optional(),
    clientId: z.string().optional(),
    session: z.string().optional(),
    tabIndex: z.number().int().min(0).optional(),
    paneId: z.string().optional()
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
  z.object({ type: z.literal("capture_scrollback"), paneId: z.string(), lines: z.number().optional() }),
  z.object({ type: z.literal("capture_tab_history"), session: z.string().optional(), tabIndex: z.number(), lines: z.number().optional() }),
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
      clientIdPresent: Boolean(message.clientId)
    });
  }
  if (message.type === "send_compose") {
    return JSON.stringify({
      type: message.type,
      textLength: message.text.length
    });
  }
  return JSON.stringify({ type: message.type });
};

export const summarizeState = (state: WorkspaceSnapshot): string => {
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

export { isObject };
