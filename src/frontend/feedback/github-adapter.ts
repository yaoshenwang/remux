import { buildGitHubIssueApiUrl, buildRemuxAuthHeaders } from "./github";

const GITHUB_CLIENT_ID = "Ov23ctnKbEALA3WUk14j";
const GITHUB_TOKEN_STORAGE_KEY = "remux-github-token";
const QUEUED_DELIVERY_ID = "queued_for_authorization";
const DEFAULT_DEVICE_FLOW_POLL_ATTEMPTS = 60;

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type LoggerLike = Pick<Console, "log" | "error">;

type SnapfeedEvent = Record<string, unknown> & {
  detail?: Record<string, unknown>;
  screenshot?: string | null;
  page?: string;
  target?: string;
  ts?: string;
  session_id?: string;
};

type AdapterResult = {
  ok: boolean;
  error?: string;
  deliveryId?: string;
  deliveryUrl?: string;
};

type DeviceCodeResponse = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  interval?: number;
};

type AccessTokenResponse = {
  access_token?: string;
  error?: string;
};

type CreateAdapterOptions = {
  authToken: string;
  clientId?: string;
  fetchFn?: FetchLike;
  issueApiUrl?: string;
  localStorageRef?: StorageLike;
  logger?: LoggerLike;
  sessionStorageRef?: StorageLike;
  showDeviceFlowDialog?: (userCode: string, verificationUri: string) => Promise<boolean>;
  now?: () => Date;
};

const delay = async (ms: number): Promise<void> => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
};

const getBrowserStorage = (storage: Storage | undefined): StorageLike | null => {
  if (!storage) {
    return null;
  }

  return storage;
};

const safeGetStorageValue = (storage: StorageLike | null, key: string): string | null => {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
};

const safeSetStorageValue = (storage: StorageLike | null, key: string, value: string): void => {
  try {
    storage?.setItem(key, value);
  } catch {
    // Ignore storage write failures so feedback delivery still works.
  }
};

const safeRemoveStorageValue = (storage: StorageLike | null, key: string): void => {
  try {
    storage?.removeItem(key);
  } catch {
    // Ignore storage removal failures so auth recovery still works.
  }
};

const copyText = async (text: string): Promise<void> => {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Ignore clipboard failures.
  }
};

const dismissDeviceFlowDialog = (): void => {
  const dismiss = (window as unknown as Record<string, (() => void) | undefined>).__ghAuthDismiss;
  dismiss?.();
  delete (window as unknown as Record<string, unknown>).__ghAuthDismiss;
};

export function showDeviceFlowDialog(userCode: string, verificationUri: string): Promise<boolean> {
  return new Promise((resolve) => {
    dismissDeviceFlowDialog();

    const overlay = document.createElement("div");
    overlay.className = "gh-auth-overlay";
    overlay.innerHTML = `
      <div class="gh-auth-card">
        <div class="gh-auth-header">
          <svg height="32" viewBox="0 0 16 16" width="32" fill="currentColor">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38
            0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15
            -.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87
            .51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12
            0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82
            2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65
            3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013
            8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
          </svg>
          <h2>Sign in with GitHub</h2>
        </div>
        <p class="gh-auth-desc">To submit feedback as a GitHub issue, authorize remux with your account.</p>
        <div class="gh-auth-steps">
          <div class="gh-auth-step">
            <span class="gh-auth-step-num">1</span>
            <span>Open <a href="${verificationUri}" target="_blank" rel="noopener">${verificationUri}</a></span>
          </div>
          <div class="gh-auth-step">
            <span class="gh-auth-step-num">2</span>
            <span>Enter this code:</span>
          </div>
        </div>
        <div class="gh-auth-code-row">
          <code class="gh-auth-code">${userCode}</code>
          <button class="gh-auth-copy" title="Copy code">Copy</button>
        </div>
        <div class="gh-auth-actions">
          <a href="${verificationUri}" target="_blank" rel="noopener" class="gh-auth-open-btn">Open GitHub -></a>
          <button class="gh-auth-cancel">Cancel</button>
        </div>
        <p class="gh-auth-waiting">Waiting for authorization...</p>
      </div>
    `;

    document.body.appendChild(overlay);

    const cleanup = (): void => {
      if (overlay.parentNode) {
        document.body.removeChild(overlay);
      }
    };

    const copyBtn = overlay.querySelector(".gh-auth-copy") as HTMLButtonElement;
    copyBtn.addEventListener("click", () => {
      void copyText(userCode).then(() => {
        copyBtn.textContent = "Copied";
        setTimeout(() => {
          copyBtn.textContent = "Copy";
        }, 2000);
      });
    });

    const cancelBtn = overlay.querySelector(".gh-auth-cancel") as HTMLButtonElement;
    cancelBtn.addEventListener("click", () => {
      cleanup();
      delete (window as unknown as Record<string, unknown>).__ghAuthDismiss;
      resolve(false);
    });

    const openBtn = overlay.querySelector(".gh-auth-open-btn") as HTMLAnchorElement;
    openBtn.addEventListener("click", () => {
      void copyText(userCode).then(() => {
        copyBtn.textContent = "Copied";
      });
    });

    (window as unknown as Record<string, () => void>).__ghAuthDismiss = cleanup;
    resolve(true);
  });
}

const createIssuePayload = (event: SnapfeedEvent, now: () => Date): { body: string; title: string } => {
  const detail = (event.detail ?? {}) as Record<string, unknown>;
  const message = String(detail.message || event.target || "No message");
  const category = String(detail.category ?? "feedback");
  const page = String(event.page ?? "/");

  const lines = [
    `**Category:** ${category}`,
    `**Page:** \`${page}\``,
    `**Timestamp:** ${String(event.ts ?? now().toISOString())}`,
    `**Session:** \`${String(event.session_id ?? "")}\``,
  ];

  if (detail.user) {
    const user = detail.user as Record<string, unknown>;
    if (user.name) {
      lines.push(`**User:** ${user.name}`);
    }
    if (user.email) {
      lines.push(`**Email:** ${user.email}`);
    }
  }

  lines.push("", "### Message", "", message);

  const contextFields: Array<[string, string]> = [
    ["tag", "Element"],
    ["path", "CSS Path"],
    ["text", "Text"],
    ["label", "Label"],
    ["component", "Component"],
    ["source_file", "Source File"],
    ["url", "URL"],
  ];
  const hasContext = contextFields.some(([key]) => detail[key]);
  if (hasContext) {
    lines.push("", "### Context", "");
    lines.push("| Property | Value |", "|----------|-------|");
    for (const [key, label] of contextFields) {
      if (detail[key]) {
        lines.push(`| ${label} | \`${String(detail[key]).substring(0, 200)}\` |`);
      }
    }
    if (detail.source_line) {
      lines.push(`| Line | ${detail.source_line} |`);
    }
  }

  const consoleErrors = detail.console_errors;
  if (Array.isArray(consoleErrors) && consoleErrors.length > 0) {
    lines.push("", "### Console Errors", "", "```", ...consoleErrors.slice(0, 10).map(String), "```");
  }

  const networkLog = detail.network_log;
  if (Array.isArray(networkLog) && networkLog.length > 0) {
    lines.push("", "### Network Log", "", "| Method | URL | Status | Duration |", "|--------|-----|--------|----------|");
    for (const entry of networkLog.slice(-10)) {
      const record = entry as Record<string, unknown>;
      lines.push(
        `| ${record.method ?? ""} | \`${String(record.url ?? "").substring(0, 80)}\` | ${record.status ?? ""} | ${record.durationMs ?? ""}ms |`,
      );
    }
  }

  const replayData = detail.replay_data;
  if (Array.isArray(replayData) && replayData.length > 0) {
    lines.push(
      "",
      `### Session Replay (${replayData.length} events)`,
      "",
      "<details><summary>Click to expand</summary>",
      "",
      "```json",
      JSON.stringify(replayData.slice(-20), null, 2),
      "```",
      "",
      "</details>",
    );
  }

  const screenshot = event.screenshot;
  if (typeof screenshot === "string" && screenshot.length > 0) {
    const dataUrl = screenshot.startsWith("data:") ? screenshot : `data:image/jpeg;base64,${screenshot}`;
    lines.push("", "### Screenshot", "", `![feedback screenshot](${dataUrl})`);
  }

  const title = `[Feedback] ${message.substring(0, 80)}${message.length > 80 ? "..." : ""}`;
  return {
    body: lines.join("\n"),
    title,
  };
};

const createLabels = (event: SnapfeedEvent): string[] => {
  const detail = (event.detail ?? {}) as Record<string, unknown>;
  const category = String(detail.category ?? "feedback");
  const labels = ["feedback"];
  const categoryMap: Record<string, string> = {
    bug: "bug",
    idea: "enhancement",
    praise: "praise",
    question: "question",
  };

  if (categoryMap[category]) {
    labels.push(categoryMap[category]);
  }

  return labels;
};

export function createLazyGithubAdapter(options: CreateAdapterOptions): {
  name: string;
  send: (event: SnapfeedEvent) => Promise<AdapterResult>;
} {
  const fetchFn = options.fetchFn ?? fetch;
  const logger = options.logger ?? console;
  const issueApiUrl = options.issueApiUrl ?? buildGitHubIssueApiUrl();
  const now = options.now ?? (() => new Date());
  const localStorageRef = options.localStorageRef ?? getBrowserStorage(globalThis.localStorage);
  const sessionStorageRef = options.sessionStorageRef ?? getBrowserStorage(globalThis.sessionStorage);
  const renderDeviceFlowDialog = options.showDeviceFlowDialog ?? showDeviceFlowDialog;
  const clientId = options.clientId ?? GITHUB_CLIENT_ID;
  const pendingEvents: SnapfeedEvent[] = [];
  let backgroundDelivery: Promise<void> | null = null;
  let authFlow: Promise<string | null> | null = null;

  const getRemuxAuthHeaders = (): Record<string, string> =>
    buildRemuxAuthHeaders(options.authToken, safeGetStorageValue(sessionStorageRef, "remux-password") ?? undefined);

  const storeToken = async (token: string): Promise<void> => {
    safeSetStorageValue(localStorageRef, GITHUB_TOKEN_STORAGE_KEY, token);
    try {
      await fetchFn("/api/auth/github-token", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...getRemuxAuthHeaders(),
        },
        body: JSON.stringify({ token }),
      });
    } catch {
      // Best-effort sync to server-side storage.
    }
  };

  const clearToken = async (): Promise<void> => {
    safeRemoveStorageValue(localStorageRef, GITHUB_TOKEN_STORAGE_KEY);
    try {
      await fetchFn("/api/auth/github-token", {
        method: "DELETE",
        headers: getRemuxAuthHeaders(),
      });
    } catch {
      // Ignore token cleanup failures so the next attempt can still continue.
    }
  };

  const readServerToken = async (): Promise<string | null> => {
    try {
      const response = await fetchFn("/api/auth/github-token", {
        headers: getRemuxAuthHeaders(),
      });
      if (!response.ok) {
        return null;
      }
      const data = await response.json() as { token: string | null };
      if (data.token) {
        safeSetStorageValue(localStorageRef, GITHUB_TOKEN_STORAGE_KEY, data.token);
        return data.token;
      }
    } catch {
      // Fall back to device flow when the backend token cannot be read.
    }

    return null;
  };

  const postIssue = async (event: SnapfeedEvent, token: string): Promise<AdapterResult & { status?: number }> => {
    const payload = createIssuePayload(event, now);

    const response = await fetchFn(issueApiUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/vnd.github.v3+json",
      },
      body: JSON.stringify({
        title: payload.title,
        body: payload.body,
        labels: createLabels(event),
      }),
    });

    if (!response.ok) {
      const responseBody = await response.text();
      logger.error("[github-adapter] GitHub API error:", response.status, responseBody);
      return {
        ok: false,
        error: `GitHub API ${response.status}`,
        status: response.status,
      };
    }

    const issue = await response.json() as { number?: number; html_url?: string };
    logger.log("[github-adapter] issue created:", issue.number);
    return {
      ok: true,
      deliveryId: String(issue.number ?? ""),
      deliveryUrl: issue.html_url,
      status: response.status,
    };
  };

  const runDeviceFlow = async (): Promise<string | null> => {
    try {
      const codeResponse = await fetchFn("/api/auth/github/device-code", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          ...getRemuxAuthHeaders(),
        },
        body: JSON.stringify({
          client_id: clientId,
          scope: "public_repo",
        }),
      });

      if (!codeResponse.ok) {
        logger.error("[github-adapter] failed to start device flow:", codeResponse.status);
        return null;
      }

      const codeData = await codeResponse.json() as DeviceCodeResponse;
      const proceed = await renderDeviceFlowDialog(codeData.user_code, codeData.verification_uri);
      if (!proceed) {
        return null;
      }

      const intervalMs = Math.max(1, codeData.interval ?? 5) * 1000;
      for (let attempt = 0; attempt < DEFAULT_DEVICE_FLOW_POLL_ATTEMPTS; attempt += 1) {
        await delay(intervalMs);
        const accessTokenResponse = await fetchFn("/api/auth/github/access-token", {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            ...getRemuxAuthHeaders(),
          },
          body: JSON.stringify({
            client_id: clientId,
            device_code: codeData.device_code,
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          }),
        });

        const accessTokenData = await accessTokenResponse.json() as AccessTokenResponse;
        if (accessTokenData.access_token) {
          dismissDeviceFlowDialog();
          await storeToken(accessTokenData.access_token);
          return accessTokenData.access_token;
        }

        if (accessTokenData.error === "authorization_pending") {
          continue;
        }

        if (accessTokenData.error === "slow_down") {
          await delay(5000);
          continue;
        }

        break;
      }
    } catch (error) {
      logger.error("[github-adapter] GitHub device flow failed:", error);
    }

    return null;
  };

  const ensureAuthToken = async (): Promise<string | null> => {
    const cachedToken = safeGetStorageValue(localStorageRef, GITHUB_TOKEN_STORAGE_KEY);
    if (cachedToken) {
      return cachedToken;
    }

    const serverToken = await readServerToken();
    if (serverToken) {
      return serverToken;
    }

    if (!authFlow) {
      authFlow = runDeviceFlow().finally(() => {
        authFlow = null;
      });
    }

    return authFlow;
  };

  const flushPendingEvents = async (): Promise<void> => {
    let token = await ensureAuthToken();
    if (!token) {
      return;
    }

    while (pendingEvents.length > 0) {
      const event = pendingEvents[0];
      const result = await postIssue(event, token);
      if (result.ok) {
        pendingEvents.shift();
        continue;
      }

      if (result.status === 401) {
        await clearToken();
        token = await ensureAuthToken();
        if (!token) {
          return;
        }
        continue;
      }

      return;
    }
  };

  const startBackgroundDelivery = (): void => {
    if (backgroundDelivery) {
      return;
    }

    backgroundDelivery = flushPendingEvents().finally(() => {
      backgroundDelivery = null;
      if (pendingEvents.length > 0) {
        startBackgroundDelivery();
      }
    });
  };

  return {
    name: "github",
    async send(event) {
      logger.log("[github-adapter] send called with event:", JSON.stringify(event).substring(0, 500));

      const cachedToken = safeGetStorageValue(localStorageRef, GITHUB_TOKEN_STORAGE_KEY);
      if (cachedToken) {
        const directResult = await postIssue(event, cachedToken);
        if (directResult.ok) {
          const { status: _status, ...publicResult } = directResult;
          return publicResult;
        }
        if (directResult.status !== 401) {
          const { status: _status, ...publicResult } = directResult;
          return publicResult;
        }

        await clearToken();
      }

      pendingEvents.push(event);
      startBackgroundDelivery();
      return {
        ok: true,
        deliveryId: QUEUED_DELIVERY_ID,
      };
    },
  };
}
