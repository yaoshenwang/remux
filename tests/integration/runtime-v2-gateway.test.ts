import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { WebSocket, type RawData } from "ws";
import { AuthService } from "../../src/backend/auth/auth-service.js";
import type { RuntimeConfig } from "../../src/backend/config.js";
import {
  createRemuxV2GatewayServer,
  type RunningServer,
} from "../../src/backend/server-v2.js";
import { FakeRuntimeV2Server } from "../harness/fakeRuntimeV2Server.js";
import { openSocket, waitForMessage } from "../harness/ws.js";

const silentLogger = { log: () => undefined, error: () => undefined };

const buildConfig = (token: string): RuntimeConfig => ({
  port: 0,
  host: "127.0.0.1",
  password: undefined,
  tunnel: false,
  defaultSession: "main",
  inspectLines: 1000,
  pollIntervalMs: 100,
  token,
  frontendDir: process.cwd(),
});

const waitForTerminalFrame = (
  socket: WebSocket,
  timeoutMs = 3_000
): Promise<{ isBinary: boolean; text: string }> =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for terminal frame")), timeoutMs);
    const handler = (raw: RawData, isBinary: boolean) => {
      clearTimeout(timeout);
      socket.off("message", handler);
      resolve({
        isBinary,
        text: raw.toString("utf8"),
      });
    };
    socket.on("message", handler);
  });

const waitForRawMessage = async (socket: WebSocket, timeoutMs = 3_000): Promise<string> =>
  (await waitForTerminalFrame(socket, timeoutMs)).text;

const expectNoRawMessage = async (socket: WebSocket, timeoutMs = 250): Promise<void> =>
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off("message", handler);
      resolve();
    }, timeoutMs);
    const handler = () => {
      clearTimeout(timeout);
      socket.off("message", handler);
      reject(new Error("Unexpected terminal frame"));
    };
    socket.on("message", handler);
  });

const authControlClient = async (
  baseWsUrl: string,
): Promise<{ control: WebSocket; clientId: string }> => {
  const control = await openSocket(`${baseWsUrl}/ws/control`);
  const authOkPromise = waitForMessage<{ type: "auth_ok"; clientId: string }>(
    control,
    (message) => message.type === "auth_ok",
  );
  control.send(JSON.stringify({ type: "auth", token: "test-token" }));
  const authOk = await authOkPromise;
  await waitForMessage(control, (message: { type: string }) => message.type === "attached");
  await waitForMessage(control, (message: { type: string }) => message.type === "workspace_state");
  return { control, clientId: authOk.clientId };
};

const authTerminalClient = async (
  baseWsUrl: string,
  clientId: string,
  size: { cols: number; rows: number },
  options?: { transportMode?: "raw" | "patch"; viewRevision?: number; baseRevision?: number },
): Promise<{ terminal: WebSocket; initialSnapshot: string }> => {
  const terminal = await openSocket(`${baseWsUrl}/ws/terminal`);
  const initialSnapshotPromise = waitForRawMessage(terminal);
  terminal.send(JSON.stringify({
    type: "auth",
    token: "test-token",
    clientId,
    ...(options?.transportMode ? { transportMode: options.transportMode } : {}),
    ...(typeof options?.viewRevision === "number" ? { viewRevision: options.viewRevision } : {}),
    ...(typeof options?.baseRevision === "number" ? { baseRevision: options.baseRevision } : {}),
    cols: size.cols,
    rows: size.rows,
  }));
  const initialSnapshot = await initialSnapshotPromise;
  return { terminal, initialSnapshot };
};

describe("runtime v2 gateway server", () => {
  let upstream: FakeRuntimeV2Server;
  let server: RunningServer;
  let baseUrl: string;
  let baseWsUrl: string;

  beforeEach(async () => {
    delete process.env.REMUX_TERMINAL_TRANSPORT_MODE;
    upstream = new FakeRuntimeV2Server();
    const upstreamBaseUrl = await upstream.start();
    server = createRemuxV2GatewayServer(buildConfig("test-token"), {
      authService: new AuthService({ token: "test-token" }),
      logger: silentLogger,
      upstreamBaseUrl,
    });
    await server.start();
    const address = server.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    baseWsUrl = `ws://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    delete process.env.REMUX_TERMINAL_TRANSPORT_MODE;
    await server.stop();
    await upstream.stop();
  });

  test("bridges auth, workspace snapshots, inspect, and terminal retargeting", async () => {
    const control = await openSocket(`${baseWsUrl}/ws/control`);
    let terminal: WebSocket | null = null;
    try {
      const authOkPromise = waitForMessage<{ type: "auth_ok"; clientId: string }>(
        control,
        (message) => message.type === "auth_ok",
      );
      const attachedPromise = waitForMessage<{ type: "attached"; session: string }>(
        control,
        (message) => message.type === "attached",
      );
      const workspaceStatePromise = waitForMessage<{
        type: "workspace_state";
        workspace: { sessions: Array<{ name: string; tabs: Array<{ panes: Array<{ id: string }> }> }> };
      }>(control, (message) => message.type === "workspace_state");

      control.send(JSON.stringify({ type: "auth", token: "test-token" }));

      const authOk = await authOkPromise;
      const attached = await attachedPromise;
      const workspaceState = await workspaceStatePromise;

      expect(attached.session).toBe("main");
      expect(workspaceState.workspace.sessions[0]?.name).toBe("main");
      expect(workspaceState.workspace.sessions[0]?.tabs[0]?.panes[0]?.id).toBe("pane-1");

      terminal = await openSocket(`${baseWsUrl}/ws/terminal`);
      const initialSnapshotPromise = waitForRawMessage(terminal);
      terminal.send(JSON.stringify({
        type: "auth",
        token: "test-token",
        clientId: authOk.clientId,
        cols: 120,
        rows: 40,
      }));

      expect(await initialSnapshotPromise).toContain("PANE_ONE_READY");

      control.send(JSON.stringify({
        type: "capture_tab_history",
        session: "main",
        tabIndex: 0,
        lines: 128,
      }));

      const tabHistory = await waitForMessage<{
        type: "tab_history";
        panes: Array<{ paneId: string; text: string }>;
      }>(control, (message) => message.type === "tab_history");
      expect(tabHistory.panes[0]).toMatchObject({
        paneId: "pane-1",
        text: "PANE_ONE_READY",
      });

      const switchedTerminalSnapshotPromise = waitForRawMessage(terminal);
      control.send(JSON.stringify({
        type: "split_pane",
        paneId: "pane-1",
        direction: "right",
      }));

      const updatedWorkspace = await waitForMessage<{
        type: "workspace_state";
        workspace: { sessions: Array<{ tabs: Array<{ panes: Array<{ id: string; active: boolean }> }> }> };
      }>(control, (message) => message.type === "workspace_state" && message.workspace.sessions[0]?.tabs[0]?.panes.length === 2);
      expect(updatedWorkspace.workspace.sessions[0]?.tabs[0]?.panes[1]).toMatchObject({
        id: "pane-2",
        active: true,
      });

      const switchedTerminalSnapshot = await switchedTerminalSnapshotPromise;
      expect(switchedTerminalSnapshot).toContain("PANE_TWO_READY");

      const echoedInputPromise = waitForRawMessage(terminal);
      terminal.send("echo hi\r");
      expect(await echoedInputPromise).toContain("echo hi\r");
    } finally {
      terminal?.close();
      control.close();
    }
  });

  test("restores live terminal streaming after the upstream pane socket drops unexpectedly", async () => {
    const { control, clientId } = await authControlClient(baseWsUrl);
    let terminal: WebSocket | null = null;

    try {
      upstream.terminateNextTerminalSocketAfterSnapshot();
      const authResult = await authTerminalClient(baseWsUrl, clientId, { cols: 120, rows: 40 });
      terminal = authResult.terminal;
      expect(authResult.initialSnapshot).toContain("PANE_ONE_READY");

      await new Promise((resolve) => setTimeout(resolve, 50));
      upstream.pushTerminalOutput("pane-1", "RECOVERED_AFTER_UPSTREAM_DROP\r\n");

      await expect
        .poll(async () => {
          const frame = await waitForTerminalFrame(terminal!, 1_000).catch(() => null);
          return frame?.text ?? "";
        }, { timeout: 5_000 })
        .toContain("RECOVERED_AFTER_UPSTREAM_DROP");
    } finally {
      terminal?.close();
      control.close();
    }
  });

  test("preserves runtime pane command metadata in workspace snapshots", async () => {
    const control = await openSocket(`${baseWsUrl}/ws/control`);

    try {
      const workspaceStatePromise = waitForMessage<{
        type: "workspace_state";
        workspace: {
          sessions: Array<{
            tabs: Array<{
              panes: Array<{
                id: string;
                currentCommand: string;
                currentPath: string;
              }>;
            }>;
          }>;
        };
      }>(control, (message) => message.type === "workspace_state");

      control.send(JSON.stringify({ type: "auth", token: "test-token" }));
      await waitForMessage(control, (message: { type: string }) => message.type === "auth_ok");
      await waitForMessage(control, (message: { type: string }) => message.type === "attached");
      const workspaceState = await workspaceStatePromise;

      expect(workspaceState.workspace.sessions[0]?.tabs[0]?.panes[0]).toMatchObject({
        id: "pane-1",
        currentCommand: "bash",
        currentPath: "/workspace/main",
      });
    } finally {
      control.close();
    }
  });

  test("keeps one shared upstream pane bridge pinned to the existing resize owner when another viewer only observes", async () => {
    const first = await authControlClient(baseWsUrl);
    const second = await authControlClient(baseWsUrl);
    let terminalA: WebSocket | null = null;
    let terminalB: WebSocket | null = null;

    try {
      ({ terminal: terminalA } = await authTerminalClient(baseWsUrl, first.clientId, { cols: 120, rows: 40 }));
      ({ terminal: terminalB } = await authTerminalClient(baseWsUrl, second.clientId, { cols: 48, rows: 18 }));

      await expect.poll(() => upstream.latestTerminal("pane-1")?.attachCount ?? 0).toBe(1);
      await expect.poll(() => upstream.latestTerminal("pane-1")?.sizes ?? []).toEqual([
        { cols: 120, rows: 40 },
      ]);

      const firstViewerEcho = waitForRawMessage(terminalA);
      const secondViewerEcho = waitForRawMessage(terminalB);
      terminalB.send("echo shared-view\r");

      expect(await firstViewerEcho).toContain("echo shared-view\r");
      expect(await secondViewerEcho).toContain("echo shared-view\r");
      expect(upstream.latestTerminal("pane-1")?.writes.at(-1)).toBe("echo shared-view\r");
      await expect.poll(() => upstream.latestTerminal("pane-1")?.sizes ?? []).toEqual([
        { cols: 120, rows: 40 },
        { cols: 48, rows: 18 },
      ]);
    } finally {
      terminalA?.close();
      terminalB?.close();
      first.control.close();
      second.control.close();
    }
  });

  test("lets the viewer that starts writing take resize ownership for subsequent viewport changes", async () => {
    const first = await authControlClient(baseWsUrl);
    const second = await authControlClient(baseWsUrl);
    let terminalA: WebSocket | null = null;
    let terminalB: WebSocket | null = null;

    try {
      ({ terminal: terminalA } = await authTerminalClient(baseWsUrl, first.clientId, { cols: 120, rows: 40 }));
      ({ terminal: terminalB } = await authTerminalClient(baseWsUrl, second.clientId, { cols: 48, rows: 18 }));

      await expect.poll(() => upstream.latestTerminal("pane-1")?.sizes ?? []).toEqual([
        { cols: 120, rows: 40 },
      ]);

      const firstViewerEcho = waitForRawMessage(terminalA);
      const secondViewerEcho = waitForRawMessage(terminalB);
      terminalB.send("echo claim-owner\r");

      expect(await firstViewerEcho).toContain("echo claim-owner\r");
      expect(await secondViewerEcho).toContain("echo claim-owner\r");
      await expect.poll(() => upstream.latestTerminal("pane-1")?.sizes ?? []).toEqual([
        { cols: 120, rows: 40 },
        { cols: 48, rows: 18 },
      ]);

      terminalB.send(JSON.stringify({ type: "resize", cols: 52, rows: 20 }));

      await expect.poll(() => upstream.latestTerminal("pane-1")?.sizes ?? []).toEqual([
        { cols: 120, rows: 40 },
        { cols: 48, rows: 18 },
        { cols: 52, rows: 20 },
      ]);
    } finally {
      terminalA?.close();
      terminalB?.close();
      first.control.close();
      second.control.close();
    }
  });

  test("keeps each viewer pinned to its own session when another client switches the backend focus", async () => {
    const first = await authControlClient(baseWsUrl);
    const second = await authControlClient(baseWsUrl);
    let terminalA: WebSocket | null = null;

    try {
      ({ terminal: terminalA } = await authTerminalClient(baseWsUrl, first.clientId, { cols: 120, rows: 40 }));

      const firstWorkspaceUpdate = waitForMessage<{
        type: "workspace_state";
        workspace: { sessions: Array<{ name: string }> };
        clientView: { sessionName: string };
      }>(
        first.control,
        (message) => message.type === "workspace_state" && message.workspace.sessions.some((session) => session.name === "other"),
      );
      const secondWorkspaceUpdate = waitForMessage<{
        type: "workspace_state";
        clientView: { sessionName: string };
      }>(
        second.control,
        (message) => message.type === "workspace_state" && message.clientView.sessionName === "other",
      );

      second.control.send(JSON.stringify({ type: "new_session", name: "other" }));

      const [firstWorkspace, secondWorkspace] = await Promise.all([
        firstWorkspaceUpdate,
        secondWorkspaceUpdate,
      ]);

      expect(secondWorkspace.clientView.sessionName).toBe("other");
      expect(firstWorkspace.clientView.sessionName).toBe("main");
      expect(upstream.latestTerminal("pane-2")?.attachCount ?? 0).toBe(0);
      expect(upstream.latestTerminal("pane-1")?.attachCount ?? 0).toBe(1);
    } finally {
      terminalA?.close();
      first.control.close();
      second.control.close();
    }
  });

  test("moves only the initiating viewer terminal bridge when switching to a new session", async () => {
    const first = await authControlClient(baseWsUrl);
    const second = await authControlClient(baseWsUrl);
    let terminalA: WebSocket | null = null;
    let terminalB: WebSocket | null = null;

    try {
      ({ terminal: terminalA } = await authTerminalClient(baseWsUrl, first.clientId, { cols: 120, rows: 40 }));
      ({ terminal: terminalB } = await authTerminalClient(baseWsUrl, second.clientId, { cols: 80, rows: 24 }));

      await expect.poll(() => upstream.latestTerminal("pane-1")?.attachCount ?? 0).toBe(1);

      const secondWorkspaceUpdate = waitForMessage<{
        type: "workspace_state";
        clientView: { sessionName: string };
      }>(
        second.control,
        (message) => message.type === "workspace_state" && message.clientView.sessionName === "other",
      );

      second.control.send(JSON.stringify({ type: "new_session", name: "other" }));

      await secondWorkspaceUpdate;
      await expect.poll(() => upstream.latestTerminal("pane-2")?.attachCount ?? 0).toBe(1);

      terminalA.send("echo first-viewer\r");
      await expect.poll(() => upstream.latestTerminal("pane-1")?.writes.at(-1)).toBe("echo first-viewer\r");

      terminalB.send("echo second-viewer\r");
      await expect.poll(() => upstream.latestTerminal("pane-2")?.writes.at(-1)).toBe("echo second-viewer\r");
    } finally {
      terminalA?.close();
      terminalB?.close();
      first.control.close();
      second.control.close();
    }
  });

  test("publishes a stable view revision and bumps it when the client retargets to a new pane", async () => {
    const control = await openSocket(`${baseWsUrl}/ws/control`);

    try {
      const authOkPromise = waitForMessage<{ type: "auth_ok"; clientId: string }>(
        control,
        (message) => message.type === "auth_ok",
      );
      const attachedPromise = waitForMessage<{ type: "attached"; session: string; viewRevision: number }>(
        control,
        (message) => message.type === "attached",
      );
      const workspaceStatePromise = waitForMessage<{
        type: "workspace_state";
        viewRevision: number;
        clientView: { paneId: string };
      }>(
        control,
        (message) => message.type === "workspace_state",
      );

      control.send(JSON.stringify({ type: "auth", token: "test-token" }));

      await authOkPromise;
      const attached = await attachedPromise;
      const workspaceState = await workspaceStatePromise;

      expect(attached.viewRevision).toBe(1);
      expect(workspaceState.viewRevision).toBe(1);
      expect(workspaceState.clientView.paneId).toBe("pane-1");

      const nextWorkspaceStatePromise = waitForMessage<{
        type: "workspace_state";
        viewRevision: number;
        clientView: { paneId: string };
      }>(
        control,
        (message) => message.type === "workspace_state" && message.viewRevision > 1,
      );

      control.send(JSON.stringify({
        type: "split_pane",
        paneId: "pane-1",
        direction: "right",
      }));

      const nextWorkspaceState = await nextWorkspaceStatePromise;

      expect(nextWorkspaceState.viewRevision).toBe(2);
      expect(nextWorkspaceState.clientView.paneId).toBe("pane-2");
    } finally {
      control.close();
    }
  });

  test("negotiates terminal_patch transport and tags patches with the current view revision", async () => {
    const { control, clientId } = await authControlClient(baseWsUrl);
    let terminal: WebSocket | null = null;

    try {
      const authResult = await authTerminalClient(
        baseWsUrl,
        clientId,
        { cols: 120, rows: 40 },
        { transportMode: "patch" },
      );
      terminal = authResult.terminal;

      const snapshotFrame = JSON.parse(authResult.initialSnapshot) as {
        type: string;
        paneId: string;
        epoch: number;
        viewRevision: number;
        revision: number;
        baseRevision: number | null;
        reset: boolean;
        source: string;
        dataBase64: string;
        payload?: {
          encoding: string;
          chunksBase64: string[];
        };
      };
      expect(snapshotFrame).toMatchObject({
        type: "terminal_patch",
        paneId: "pane-1",
        epoch: 1,
        viewRevision: 1,
        revision: 1,
        baseRevision: null,
        reset: true,
        source: "snapshot",
      });
      expect(Buffer.from(snapshotFrame.dataBase64, "base64").toString("utf8")).toContain("PANE_ONE_READY");
      expect(snapshotFrame.payload).toMatchObject({
        encoding: "base64_chunks_v1",
        chunksBase64: [snapshotFrame.dataBase64],
      });

      upstream.pushTerminalOutput("pane-1", "PATCH_FLOW\r\n");
      const streamFrame = JSON.parse(await waitForRawMessage(terminal)) as {
        type: string;
        epoch: number;
        viewRevision: number;
        revision: number;
        baseRevision: number | null;
        reset: boolean;
        source: string;
        dataBase64: string;
        payload?: {
          encoding: string;
          chunksBase64: string[];
        };
      };
      expect(streamFrame).toMatchObject({
        type: "terminal_patch",
        epoch: 1,
        viewRevision: 1,
        revision: 2,
        baseRevision: 1,
        reset: false,
        source: "stream",
      });
      expect(Buffer.from(streamFrame.dataBase64, "base64").toString("utf8")).toBe("PATCH_FLOW\r\n");
      expect(streamFrame.payload).toMatchObject({
        encoding: "base64_chunks_v1",
        chunksBase64: [streamFrame.dataBase64],
      });

      const switchedSnapshotPromise = waitForRawMessage(terminal);
      control.send(JSON.stringify({
        type: "split_pane",
        paneId: "pane-1",
        direction: "right",
      }));

      const switchedFrame = JSON.parse(await switchedSnapshotPromise) as {
        type: string;
        paneId: string;
        epoch: number;
        viewRevision: number;
        revision: number;
        reset: boolean;
        source: string;
      };
      expect(switchedFrame).toMatchObject({
        type: "terminal_patch",
        paneId: "pane-2",
        epoch: 1,
        viewRevision: 2,
        reset: true,
        source: "snapshot",
      });
    } finally {
      terminal?.close();
      control.close();
    }
  });

  test("continues terminal_patch from the last applied revision when reconnecting before the idle refresh snapshot arrives", async () => {
    const { control, clientId } = await authControlClient(baseWsUrl);
    let terminal: WebSocket | null = null;
    let resumedTerminal: WebSocket | null = null;

    try {
      const authResult = await authTerminalClient(
        baseWsUrl,
        clientId,
        { cols: 120, rows: 40 },
        { transportMode: "patch", viewRevision: 1 },
      );
      terminal = authResult.terminal;

      const snapshotFrame = JSON.parse(authResult.initialSnapshot) as {
        epoch: number;
        revision: number;
        reset: boolean;
        source: string;
      };
      expect(snapshotFrame).toMatchObject({
        epoch: 1,
        revision: 1,
        reset: true,
        source: "snapshot",
      });

      upstream.pushTerminalOutput("pane-1", "REVISION_TWO\r\n");
      const liveFrame = JSON.parse(await waitForRawMessage(terminal)) as {
        epoch: number;
        revision: number;
        baseRevision: number | null;
        reset: boolean;
        source: string;
      };
      expect(liveFrame).toMatchObject({
        epoch: 1,
        revision: 2,
        baseRevision: 1,
        reset: false,
        source: "stream",
      });

      upstream.delayNextTerminalSnapshot(200);
      const terminalClosed = new Promise<void>((resolve) => {
        terminal!.once("close", () => resolve());
      });
      terminal.close();
      await terminalClosed;

      await expect.poll(() => upstream.latestTerminal("pane-1")?.requestSnapshotCount ?? 0).toBe(1);

      upstream.pushTerminalOutput("pane-1", "MISSED_REVISION_THREE\r\n");

      const resumed = await authTerminalClient(
        baseWsUrl,
        clientId,
        { cols: 120, rows: 40 },
        { transportMode: "patch", viewRevision: 1, baseRevision: 2 },
      );
      resumedTerminal = resumed.terminal;

      const resumedFrame = JSON.parse(resumed.initialSnapshot) as {
        epoch: number;
        revision: number;
        baseRevision: number | null;
        reset: boolean;
        source: string;
        dataBase64: string;
      };
      expect(resumedFrame).toMatchObject({
        epoch: 1,
        revision: 3,
        baseRevision: 2,
        reset: false,
        source: "stream",
      });
      expect(Buffer.from(resumedFrame.dataBase64, "base64").toString("utf8")).toBe("MISSED_REVISION_THREE\r\n");

      await expectNoRawMessage(resumedTerminal, 300);
    } finally {
      resumedTerminal?.close();
      terminal?.close();
      control.close();
    }
  });

  test("rebuilds the latest terminal_patch snapshot for a new viewer when base revision is stale", async () => {
    const { control, clientId } = await authControlClient(baseWsUrl);
    let terminal: WebSocket | null = null;
    let staleTerminal: WebSocket | null = null;

    try {
      const authResult = await authTerminalClient(
        baseWsUrl,
        clientId,
        { cols: 120, rows: 40 },
        { transportMode: "patch", viewRevision: 1 },
      );
      terminal = authResult.terminal;

      upstream.pushTerminalOutput("pane-1", "REVISION_TWO\r\n");
      const liveFrame = JSON.parse(await waitForRawMessage(terminal)) as {
        revision: number;
        baseRevision: number | null;
        reset: boolean;
        source: string;
      };
      expect(liveFrame).toMatchObject({
        revision: 2,
        baseRevision: 1,
        reset: false,
        source: "stream",
      });

      const stale = await authTerminalClient(
        baseWsUrl,
        clientId,
        { cols: 120, rows: 40 },
        { transportMode: "patch", viewRevision: 1, baseRevision: 0 },
      );
      staleTerminal = stale.terminal;

      const rebuiltFrame = JSON.parse(stale.initialSnapshot) as {
        revision: number;
        baseRevision: number | null;
        reset: boolean;
        source: string;
        dataBase64: string;
      };
      expect(rebuiltFrame).toMatchObject({
        revision: 2,
        baseRevision: null,
        reset: true,
        source: "snapshot",
      });
      expect(Buffer.from(rebuiltFrame.dataBase64, "base64").toString("utf8")).toContain("REVISION_TWO");

      await expectNoRawMessage(staleTerminal, 300);
    } finally {
      staleTerminal?.close();
      terminal?.close();
      control.close();
    }
  });

  test("broadcasts bandwidth stats to control clients after terminal activity", async () => {
    const { control, clientId } = await authControlClient(baseWsUrl);
    let terminal: WebSocket | null = null;

    try {
      const authResult = await authTerminalClient(
        baseWsUrl,
        clientId,
        { cols: 120, rows: 40 },
        { transportMode: "patch" },
      );
      terminal = authResult.terminal;

      upstream.pushTerminalOutput("pane-1", "BANDWIDTH_FLOW\r\n");
      control.send(JSON.stringify({
        type: "report_client_diagnostic",
        viewRevision: 1,
        paneId: "pane-1",
        diagnostic: {
          issue: "revision_mismatch",
          severity: "warn",
          status: "open",
          summary: "Dropped terminal patch after revision gap",
          sample: {
            viewRevision: 1,
            terminalEpoch: 1,
          },
          recentActions: [],
        },
      }));

      const bandwidthStats = await waitForMessage<{
        type: "bandwidth_stats";
        stats: {
          fullSnapshotsSent: number;
          diffUpdatesSent: number;
          rebuiltSnapshotsSent: number;
          continuationResumes: number;
          continuationFallbackSnapshots: number;
          incrementalPatchesSent: number;
          snapshotBytesSent: number;
          streamBytesSent: number;
          rawBytesPerSec: number;
          compressedBytesPerSec: number;
          viewerQueueHighWatermarkHits: number;
          droppedBacklogFrames: number;
          staleRevisionDrops: number;
          replayToLiveTransitions: number;
          avgReplayToLiveLatencyMs: number;
        };
      }>(
        control,
        (message) => (
          message.type === "bandwidth_stats"
          && message.stats.diffUpdatesSent > 0
          && message.stats.staleRevisionDrops > 0
        ),
      );

      expect(bandwidthStats.stats.fullSnapshotsSent).toBeGreaterThan(0);
      expect(bandwidthStats.stats.diffUpdatesSent).toBeGreaterThan(0);
      expect(bandwidthStats.stats.rebuiltSnapshotsSent).toBeGreaterThanOrEqual(0);
      expect(bandwidthStats.stats.continuationResumes).toBeGreaterThanOrEqual(0);
      expect(bandwidthStats.stats.continuationFallbackSnapshots).toBeGreaterThanOrEqual(0);
      expect(bandwidthStats.stats.incrementalPatchesSent).toBeGreaterThan(0);
      expect(bandwidthStats.stats.snapshotBytesSent).toBeGreaterThan(0);
      expect(bandwidthStats.stats.streamBytesSent).toBeGreaterThan(0);
      expect(bandwidthStats.stats.rawBytesPerSec).toBeGreaterThan(0);
      expect(bandwidthStats.stats.compressedBytesPerSec).toBeGreaterThan(0);
      expect(bandwidthStats.stats.viewerQueueHighWatermarkHits).toBeGreaterThanOrEqual(0);
      expect(bandwidthStats.stats.droppedBacklogFrames).toBeGreaterThanOrEqual(0);
      expect(bandwidthStats.stats.staleRevisionDrops).toBeGreaterThan(0);
      expect(bandwidthStats.stats.replayToLiveTransitions).toBeGreaterThan(0);
      expect(bandwidthStats.stats.avgReplayToLiveLatencyMs).toBeGreaterThanOrEqual(0);
    } finally {
      terminal?.close();
      control.close();
    }
  });

  test("tags tab history with the current view revision and ignores stale client diagnostics", async () => {
    const { control } = await authControlClient(baseWsUrl);

    try {
      control.send(JSON.stringify({
        type: "capture_tab_history",
        session: "main",
        tabIndex: 0,
        lines: 64,
      }));
      const initialHistory = await waitForMessage<{
        type: "tab_history";
        viewRevision: number;
        events: Array<{ kind: string }>;
      }>(control, (message) => message.type === "tab_history");
      expect(initialHistory.viewRevision).toBe(1);
      expect(initialHistory.events.filter((event) => event.kind === "diagnostic")).toHaveLength(0);

      control.send(JSON.stringify({
        type: "split_pane",
        paneId: "pane-1",
        direction: "right",
      }));
      const nextWorkspaceState = await waitForMessage<{
        type: "workspace_state";
        viewRevision: number;
      }>(control, (message) => message.type === "workspace_state" && message.viewRevision > 1);
      expect(nextWorkspaceState.viewRevision).toBe(2);

      control.send(JSON.stringify({
        type: "report_client_diagnostic",
        viewRevision: 1,
        paneId: "pane-2",
        diagnostic: {
          issue: "width_mismatch",
          severity: "error",
          status: "open",
          summary: "stale diagnostic should be ignored",
          sample: {
            frontendCols: 40,
            backendCols: 120,
          },
          recentActions: [],
        },
      }));

      control.send(JSON.stringify({
        type: "capture_tab_history",
        session: "main",
        tabIndex: 0,
        lines: 64,
      }));
      const historyWithoutStaleDiagnostic = await waitForMessage<{
        type: "tab_history";
        viewRevision: number;
        events: Array<{ kind: string; diagnostic?: { summary?: string } }>;
      }>(control, (message) => message.type === "tab_history" && message.viewRevision === 2);
      expect(historyWithoutStaleDiagnostic.events.filter((event) => event.kind === "diagnostic")).toHaveLength(0);

      control.send(JSON.stringify({
        type: "report_client_diagnostic",
        viewRevision: 2,
        paneId: "pane-2",
        diagnostic: {
          issue: "width_mismatch",
          severity: "error",
          status: "open",
          summary: "current diagnostic should be retained",
          sample: {
            frontendCols: 40,
            backendCols: 120,
          },
          recentActions: [],
        },
      }));

      control.send(JSON.stringify({
        type: "capture_tab_history",
        session: "main",
        tabIndex: 0,
        lines: 64,
      }));
      const historyWithCurrentDiagnostic = await waitForMessage<{
        type: "tab_history";
        viewRevision: number;
        events: Array<{ kind: string; diagnostic?: { summary?: string } }>;
      }>(control, (message) => (
        message.type === "tab_history"
        && message.viewRevision === 2
        && message.events.some((event) => event.kind === "diagnostic")
      ));
      expect(historyWithCurrentDiagnostic.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "diagnostic",
            diagnostic: expect.objectContaining({
              summary: "current diagnostic should be retained",
            }),
          }),
        ]),
      );
    } finally {
      control.close();
    }
  });

  test("bridges terminal live data as binary frames and writes raw binary upstream", async () => {
    upstream.setTerminalStreamTransport("binary");

    const { control, clientId } = await authControlClient(baseWsUrl);
    let terminal: WebSocket | null = null;

    try {
      ({ terminal } = await authTerminalClient(baseWsUrl, clientId, { cols: 120, rows: 40 }));

      const echoedFramePromise = waitForTerminalFrame(terminal);
      terminal.send(Buffer.from("echo binary\r", "utf8"));

      const echoedFrame = await echoedFramePromise;
      expect(echoedFrame.isBinary).toBe(true);
      expect(echoedFrame.text).toContain("echo binary\r");
      await expect.poll(() => upstream.latestTerminal("pane-1")?.inputFrameTypes.at(-1)).toBe("binary");
      expect(upstream.latestTerminal("pane-1")?.writes.at(-1)).toBe("echo binary\r");
    } finally {
      terminal?.close();
      control.close();
    }
  });

  test("debounces repeated resize bursts down to one upstream snapshot request", async () => {
    const { control, clientId } = await authControlClient(baseWsUrl);
    let terminal: WebSocket | null = null;

    try {
      ({ terminal } = await authTerminalClient(baseWsUrl, clientId, { cols: 120, rows: 40 }));

      terminal.send(JSON.stringify({ type: "resize", cols: 100, rows: 30 }));
      terminal.send(JSON.stringify({ type: "resize", cols: 110, rows: 30 }));
      terminal.send(JSON.stringify({ type: "resize", cols: 132, rows: 30 }));

      await expect.poll(() => upstream.latestTerminal("pane-1")?.sizes.at(-1)).toEqual({ cols: 132, rows: 30 });
      await expect.poll(() => upstream.latestTerminal("pane-1")?.requestSnapshotCount ?? 0).toBe(1);
    } finally {
      terminal?.close();
      control.close();
    }
  });

  test("serves runtime-v2 config metadata", async () => {
    const response = await fetch(`${baseUrl}/api/config`);
    expect(response.status).toBe(200);
    const config = await response.json() as {
      passwordRequired: boolean;
      inspectLines: number;
      runtimeMode: string;
      backendKind?: string;
      localWebSocketOrigin?: string;
      preferredTerminalTransport?: "raw" | "patch";
    };

    expect(config.passwordRequired).toBe(false);
    expect(config.inspectLines).toBe(1000);
    expect(config.runtimeMode).toBe("runtime-v2");
    expect(config.backendKind).toBe("runtime-v2");
    expect(config.localWebSocketOrigin).toBeUndefined();
    expect(config.preferredTerminalTransport).toBe("patch");
  });

  test("forces raw terminal frames when patch transport is disabled by the server feature flag", async () => {
    await server.stop();
    await upstream.stop();
    process.env.REMUX_TERMINAL_TRANSPORT_MODE = "raw";
    upstream = new FakeRuntimeV2Server();
    const upstreamBaseUrl = await upstream.start();
    server = createRemuxV2GatewayServer(buildConfig("test-token"), {
      authService: new AuthService({ token: "test-token" }),
      logger: silentLogger,
      upstreamBaseUrl,
    });
    await server.start();
    const address = server.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    baseWsUrl = `ws://127.0.0.1:${address.port}`;

    const { control, clientId } = await authControlClient(baseWsUrl);
    let terminal: WebSocket | null = null;

    try {
      const authResult = await authTerminalClient(
        baseWsUrl,
        clientId,
        { cols: 120, rows: 40 },
        { transportMode: "patch", viewRevision: 1 },
      );
      terminal = authResult.terminal;
      expect(authResult.initialSnapshot).not.toContain("\"type\":\"terminal_patch\"");
      expect(authResult.initialSnapshot).toContain("PANE_ONE_READY");

      upstream.pushTerminalOutput("pane-1", "RAW-MODE-LIVE\r\n");
      const liveFrame = await waitForTerminalFrame(terminal);
      expect(liveFrame.isBinary).toBe(true);
      expect(liveFrame.text).toContain("RAW-MODE-LIVE");

      const response = await fetch(`${baseUrl}/api/config`);
      const config = await response.json() as { preferredTerminalTransport?: "raw" | "patch" };
      expect(config.preferredTerminalTransport).toBe("raw");
    } finally {
      terminal?.close();
      control.close();
    }
  });

  test("answers control ping messages and ignores terminal keepalive frames", async () => {
    const control = await openSocket(`${baseWsUrl}/ws/control`);
    let terminal: WebSocket | null = null;
    try {
      const authOkPromise = waitForMessage<{ type: "auth_ok"; clientId: string }>(
        control,
        (message) => message.type === "auth_ok",
      );
      control.send(JSON.stringify({ type: "auth", token: "test-token" }));
      const authOk = await authOkPromise;

      control.send(JSON.stringify({ type: "ping", timestamp: 123 }));
      const pong = await waitForMessage<{ type: "pong"; timestamp: number }>(
        control,
        (message) => message.type === "pong",
      );
      expect(pong).toEqual({ type: "pong", timestamp: 123 });

      terminal = await openSocket(`${baseWsUrl}/ws/terminal`);
      terminal.send(JSON.stringify({
        type: "auth",
        token: "test-token",
        clientId: authOk.clientId,
        cols: 120,
        rows: 40,
      }));
      await waitForRawMessage(terminal);

      terminal.send(JSON.stringify({ type: "ping" }));
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(upstream.latestTerminal("pane-1")?.writes).toEqual([]);
    } finally {
      terminal?.close();
      control.close();
    }
  });

  test("send_compose uses safe delayed submit mode through the runtime terminal bridge", async () => {
    const control = await openSocket(`${baseWsUrl}/ws/control`);
    let terminal: WebSocket | null = null;
    try {
      const authOkPromise = waitForMessage<{ type: "auth_ok"; clientId: string }>(
        control,
        (message) => message.type === "auth_ok",
      );
      control.send(JSON.stringify({ type: "auth", token: "test-token" }));
      const authOk = await authOkPromise;

      terminal = await openSocket(`${baseWsUrl}/ws/terminal`);
      terminal.send(JSON.stringify({
        type: "auth",
        token: "test-token",
        clientId: authOk.clientId,
        cols: 120,
        rows: 40,
      }));
      await waitForRawMessage(terminal);

      control.send(JSON.stringify({ type: "send_compose", text: "echo hi" }));

      await expect.poll(() => upstream.latestTerminal("pane-1")?.writes).toEqual(["echo hi", "\r"]);
    } finally {
      terminal?.close();
      control.close();
    }
  });

  test("send_compose serializes repeated submissions so commands stay separated", async () => {
    const control = await openSocket(`${baseWsUrl}/ws/control`);
    let terminal: WebSocket | null = null;
    try {
      const authOkPromise = waitForMessage<{ type: "auth_ok"; clientId: string }>(
        control,
        (message) => message.type === "auth_ok",
      );
      control.send(JSON.stringify({ type: "auth", token: "test-token" }));
      const authOk = await authOkPromise;

      terminal = await openSocket(`${baseWsUrl}/ws/terminal`);
      terminal.send(JSON.stringify({
        type: "auth",
        token: "test-token",
        clientId: authOk.clientId,
        cols: 120,
        rows: 40,
      }));
      await waitForRawMessage(terminal);

      control.send(JSON.stringify({ type: "send_compose", text: "echo first" }));
      control.send(JSON.stringify({ type: "send_compose", text: "echo second" }));

      await expect.poll(() => upstream.latestTerminal("pane-1")?.writes).toEqual([
        "echo first",
        "\r",
        "echo second",
        "\r",
      ]);
    } finally {
      terminal?.close();
      control.close();
    }
  });

  test("rejects invalid control auth", async () => {
    const control = await openSocket(`${baseWsUrl}/ws/control`);
    try {
      control.send(JSON.stringify({ type: "auth", token: "bad-token" }));
      const authError = await waitForMessage<{ type: "auth_error"; reason?: string }>(
        control,
        (message) => message.type === "auth_error",
      );
      expect(authError.reason).toContain("invalid token");
    } finally {
      control.close();
    }
  });

  test("replays persisted scrollback on attach and exposes it through inspect history", async () => {
    upstream.setPaneInspectContent("pane-1", [
      "history line 1",
      "history line 2",
      "history line 3",
    ]);
    upstream.setPaneContent("pane-1", "live line 4\r\n");

    const control = await openSocket(`${baseWsUrl}/ws/control`);
    let terminal: WebSocket | null = null;
    try {
      const authOkPromise = waitForMessage<{ type: "auth_ok"; clientId: string }>(
        control,
        (message) => message.type === "auth_ok",
      );
      control.send(JSON.stringify({ type: "auth", token: "test-token" }));
      const authOk = await authOkPromise;

      terminal = await openSocket(`${baseWsUrl}/ws/terminal`);
      const initialSnapshotPromise = waitForRawMessage(terminal);
      terminal.send(JSON.stringify({
        type: "auth",
        token: "test-token",
        clientId: authOk.clientId,
        cols: 120,
        rows: 40,
      }));

      const initialSnapshot = await initialSnapshotPromise;
      expect(initialSnapshot).toContain("history line 1");
      expect(initialSnapshot).toContain("history line 3");
      expect(initialSnapshot).toContain("live line 4");

      control.send(JSON.stringify({
        type: "capture_tab_history",
        session: "main",
        tabIndex: 0,
        lines: 64,
      }));

      const tabHistory = await waitForMessage<{
        type: "tab_history";
        panes: Array<{ paneId: string; text: string }>;
      }>(control, (message) => message.type === "tab_history");

      expect(tabHistory.panes[0]).toMatchObject({
        paneId: "pane-1",
        text: "history line 1\nhistory line 2\nhistory line 3\nlive line 4",
      });
    } finally {
      terminal?.close();
      control.close();
    }
  });
});
