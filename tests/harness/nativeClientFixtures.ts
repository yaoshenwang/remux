import type { ControlServerMessage } from "../../src/shared/protocol.js";
import type { ServerConfig } from "../../src/frontend/app-types.js";

export const nativeConfigFixture: ServerConfig = {
  version: "0.2.0",
  passwordRequired: false,
  inspectLines: 1000,
  pollIntervalMs: 2500,
  uploadMaxSize: 52_428_800,
  backendKind: "runtime-v2",
  runtimeMode: "runtime-v2",
};

export const nativeAuthOkFixture: Extract<ControlServerMessage, { type: "auth_ok" }> = {
  type: "auth_ok",
  clientId: "native-client-001",
  requiresPassword: false,
  backendKind: "runtime-v2",
  capabilities: {
    supportsPaneFocusById: true,
    supportsTabRename: true,
    supportsSessionRename: true,
    supportsPreciseInspect: true,
    supportsPreciseScrollback: true,
    supportsFloatingPanes: false,
    supportsFullscreenPane: true,
  },
  serverCapabilities: {
    protocolVersion: 1,
    workspace: {
      supportsPaneFocusById: true,
      supportsTabRename: true,
      supportsSessionRename: true,
      supportsPreciseInspect: true,
      supportsPreciseScrollback: true,
      supportsFloatingPanes: false,
      supportsFullscreenPane: true,
      supportsUpload: true,
      supportsTerminalSnapshots: false,
    },
    notifications: {
      supportsPushNotifications: false,
    },
    transport: {
      supportsTrustedReconnect: false,
      supportsPairingBootstrap: false,
      supportsDeviceIdentity: false,
    },
    semantic: {
      adaptersAvailable: [],
      adapterHealth: [],
      supportsEventStream: false,
    },
  },
};

export const nativeSessionPickerFixture: Extract<ControlServerMessage, { type: "session_picker" }> = {
  type: "session_picker",
  sessions: [
    { name: "main", attached: false, tabCount: 2 },
    { name: "ops", attached: false, tabCount: 1 },
  ],
};

export const nativeWorkspaceStateFixture: Extract<ControlServerMessage, { type: "workspace_state" }> = {
  type: "workspace_state",
  workspace: {
    capturedAt: "2026-03-26T13:00:00.000Z",
    sessions: [
      {
        name: "main",
        attached: true,
        tabCount: 1,
        tabs: [
          {
            index: 0,
            name: "shell",
            active: true,
            paneCount: 1,
            panes: [
              {
                index: 0,
                id: "%0",
                currentCommand: "bash",
                active: true,
                width: 120,
                height: 40,
                zoomed: false,
                currentPath: "/Users/wangyaoshen/dev/remux",
              },
            ],
          },
        ],
      },
    ],
  },
  clientView: {
    sessionName: "main",
    tabIndex: 0,
    paneId: "%0",
    followBackendFocus: false,
  },
};

export const nativeUploadResponseFixture = {
  ok: true,
  path: "/Users/wangyaoshen/dev/remux/notes.txt",
  filename: "notes.txt",
};

export const nativeTabHistoryFixture: Extract<ControlServerMessage, { type: "tab_history" }> = {
  type: "tab_history",
  sessionName: "main",
  tabIndex: 0,
  tabName: "shell",
  lines: 1000,
  source: "server_tab_history",
  precision: "precise",
  capturedAt: "2026-03-26T13:00:02.000Z",
  panes: [
    {
      paneId: "%0",
      paneIndex: 0,
      title: "Pane 0 · bash · %0",
      command: "bash",
      text: "npm test\nAll green.\n",
      paneWidth: 120,
      isApproximate: false,
      archived: false,
      lines: 1000,
      capturedAt: "2026-03-26T13:00:02.000Z",
    },
  ],
  events: [
    {
      id: "evt-1",
      text: "Viewed tab 0",
      createdAt: "2026-03-26T13:00:02.000Z",
    },
  ],
};

export const nativePairingBootstrapFixture = {
  url: "https://abc123.trycloudflare.com",
  token: "remux-auth-token-here",
  version: 1,
};
