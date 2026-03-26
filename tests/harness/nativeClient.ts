import { WebSocket } from "ws";
import { openSocket, waitForMessage } from "./ws.js";

export interface NativeControlClientOptions {
  baseWsUrl: string;
  token: string;
  password?: string;
  session?: string;
  tabIndex?: number;
  paneId?: string;
}

export const connectNativeControlClient = async (
  options: NativeControlClientOptions,
): Promise<{
  control: WebSocket;
  authOk: { type: "auth_ok"; clientId: string } & Record<string, unknown>;
}> => {
  const control = await openSocket(`${options.baseWsUrl}/ws/control`);
  const authOkPromise = waitForMessage<{ type: "auth_ok"; clientId: string } & Record<string, unknown>>(
    control,
    (message) => message.type === "auth_ok",
  );

  control.send(JSON.stringify({
    type: "auth",
    token: options.token,
    password: options.password,
    session: options.session,
    tabIndex: options.tabIndex,
    paneId: options.paneId,
  }));

  return {
    control,
    authOk: await authOkPromise,
  };
};

export const connectNativeTerminalClient = async (
  baseWsUrl: string,
  token: string,
  clientId: string,
  password?: string,
): Promise<WebSocket> => {
  const terminal = await openSocket(`${baseWsUrl}/ws/terminal`);
  terminal.send(JSON.stringify({
    type: "auth",
    token,
    password,
    clientId,
  }));
  return terminal;
};
