import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initSnapfeed } from "@microsoft/snapfeed";
import "@xterm/xterm/css/xterm.css";
import "./styles/app.css";
import { buildGitHubIssueApiUrl, buildRemuxAuthHeaders } from "./feedback/github";
import { token as remuxToken } from "./remux-runtime";

const GITHUB_CLIENT_ID = "Ov23ctnKbEALA3WUk14j";

const getRemuxAuthHeaders = (): Record<string, string> =>
  buildRemuxAuthHeaders(remuxToken, sessionStorage.getItem("remux-password") ?? undefined);

/** Show a styled GitHub Device Flow dialog. Returns true if user wants to proceed. */
function showDeviceFlowDialog(userCode: string, verificationUri: string): Promise<boolean> {
  return new Promise((resolve) => {
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
          <button class="gh-auth-copy" title="Copy code">📋</button>
        </div>
        <div class="gh-auth-actions">
          <a href="${verificationUri}" target="_blank" rel="noopener" class="gh-auth-open-btn">Open GitHub →</a>
          <button class="gh-auth-cancel">Cancel</button>
        </div>
        <p class="gh-auth-waiting">⏳ Waiting for authorization...</p>
      </div>
    `;

    document.body.appendChild(overlay);

    const copyBtn = overlay.querySelector(".gh-auth-copy") as HTMLButtonElement;
    copyBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(userCode).then(() => {
        copyBtn.textContent = "✓";
        setTimeout(() => { copyBtn.textContent = "📋"; }, 2000);
      });
    });

    const cancelBtn = overlay.querySelector(".gh-auth-cancel") as HTMLButtonElement;
    cancelBtn.addEventListener("click", () => {
      document.body.removeChild(overlay);
      resolve(false);
    });

    // Auto-resolve true when user clicks Open GitHub (they'll authorize in the other tab).
    const openBtn = overlay.querySelector(".gh-auth-open-btn") as HTMLAnchorElement;
    openBtn.addEventListener("click", () => {
      // Copy code to clipboard automatically.
      navigator.clipboard.writeText(userCode).catch(() => {});
      copyBtn.textContent = "✓";
    });

    // Store cleanup function so we can dismiss later.
    (window as unknown as Record<string, () => void>).__ghAuthDismiss = () => {
      if (overlay.parentNode) document.body.removeChild(overlay);
    };

    // Resolve true immediately — polling will handle the rest.
    resolve(true);
  });
}

async function githubDeviceFlow(): Promise<string | null> {
  try {
    // Use server proxy to avoid CORS (GitHub doesn't allow browser requests).
    const codeResp = await fetch("/api/auth/github/device-code", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...getRemuxAuthHeaders(),
      },
      body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, scope: "public_repo" }),
    });
    const codeData = await codeResp.json() as {
      device_code: string; user_code: string; verification_uri: string; interval: number;
    };

    const proceed = await showDeviceFlowDialog(codeData.user_code, codeData.verification_uri);
    if (!proceed) return null;

    const interval = (codeData.interval || 5) * 1000;
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, interval));
      const resp = await fetch("/api/auth/github/access-token", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          ...getRemuxAuthHeaders(),
        },
        body: JSON.stringify({
          client_id: GITHUB_CLIENT_ID,
          device_code: codeData.device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      });
      const data = await resp.json() as { access_token?: string; error?: string };
      if (data.access_token) {
        // Dismiss the auth dialog.
        (window as unknown as Record<string, (() => void) | undefined>).__ghAuthDismiss?.();
        fetch("/api/auth/github-token", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...getRemuxAuthHeaders(),
          },
          body: JSON.stringify({ token: data.access_token }),
        }).catch(() => {});
        localStorage.setItem("remux-github-token", data.access_token);
        return data.access_token;
      }
      if (data.error === "authorization_pending") continue;
      if (data.error === "slow_down") { await new Promise((r) => setTimeout(r, 5000)); continue; }
      break;
    }
  } catch (err) { console.error("GitHub device flow failed:", err); }
  return null;
}

/** Custom adapter that lazily triggers Device Flow on first feedback. */
function lazyGithubAdapter(): { name: string; send: (event: Record<string, unknown>) => Promise<{ ok: boolean; error?: string; deliveryId?: string; deliveryUrl?: string }> } {
  return {
    name: "github",
    async send(event) {
      try {
        console.log("[github-adapter] send called with event:", JSON.stringify(event).substring(0, 500));
        let token = localStorage.getItem("remux-github-token");

        // Try server-side storage.
        if (!token) {
          try {
            const resp = await fetch("/api/auth/github-token", {
              headers: getRemuxAuthHeaders(),
            });
            const data = await resp.json() as { token: string | null };
            if (data.token) {
              token = data.token;
              localStorage.setItem("remux-github-token", token);
            }
          } catch {}
        }

        // Trigger Device Flow if still no token.
        if (!token) {
          token = await githubDeviceFlow();
          if (!token) return { ok: false, error: "User cancelled GitHub authorization" };
        }

        // Create issue via GitHub API — include all snapfeed context.
        const detail = (event.detail ?? {}) as Record<string, unknown>;
        const message = String(detail.message || event.target || "No message");
        const category = String(detail.category ?? "feedback");
        const page = String(event.page ?? "/");
        const labels = ["feedback"];
        const categoryMap: Record<string, string> = { bug: "bug", idea: "enhancement", question: "question", praise: "praise" };
        if (categoryMap[category]) labels.push(categoryMap[category]);

        const lines = [
          `**Category:** ${category}`,
          `**Page:** \`${page}\``,
          `**Timestamp:** ${String(event.ts ?? new Date().toISOString())}`,
          `**Session:** \`${String(event.session_id ?? "")}\``,
        ];

        // User info.
        if (detail.user) {
          const user = detail.user as Record<string, unknown>;
          if (user.name) lines.push(`**User:** ${user.name}`);
          if (user.email) lines.push(`**Email:** ${user.email}`);
        }

        lines.push("", "### Message", "", message);

        // Element context (breadcrumb).
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
            if (detail[key]) lines.push(`| ${label} | \`${String(detail[key]).substring(0, 200)}\` |`);
          }
          if (detail.source_line) lines.push(`| Line | ${detail.source_line} |`);
        }

        // Console errors.
        const consoleErrors = detail.console_errors;
        if (Array.isArray(consoleErrors) && consoleErrors.length > 0) {
          lines.push("", "### Console Errors", "", "```", ...consoleErrors.slice(0, 10).map(String), "```");
        }

        // Network log.
        const networkLog = detail.network_log;
        if (Array.isArray(networkLog) && networkLog.length > 0) {
          lines.push("", "### Network Log", "", "| Method | URL | Status | Duration |", "|--------|-----|--------|----------|");
          for (const entry of networkLog.slice(-10)) {
            const e = entry as Record<string, unknown>;
            lines.push(`| ${e.method ?? ""} | \`${String(e.url ?? "").substring(0, 80)}\` | ${e.status ?? ""} | ${e.durationMs ?? ""}ms |`);
          }
        }

        // Session replay summary.
        const replayData = detail.replay_data;
        if (Array.isArray(replayData) && replayData.length > 0) {
          lines.push("", `### Session Replay (${replayData.length} events)`, "",
            "<details><summary>Click to expand</summary>", "",
            "```json", JSON.stringify(replayData.slice(-20), null, 2), "```",
            "", "</details>");
        }

        // Screenshot.
        const screenshot = event.screenshot as string | undefined;
        if (screenshot) {
          const dataUrl = screenshot.startsWith("data:") ? screenshot : `data:image/jpeg;base64,${screenshot}`;
          lines.push("", "### Screenshot", "", `![feedback screenshot](${dataUrl})`);
        }

        const body = lines.join("\n");
        const title = `[Feedback] ${message.substring(0, 80)}${message.length > 80 ? "…" : ""}`;

        const resp = await fetch(buildGitHubIssueApiUrl(), {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            Accept: "application/vnd.github.v3+json",
          },
          body: JSON.stringify({ title, body, labels }),
        });

        if (!resp.ok) {
          const errBody = await resp.text();
          console.error("[github-adapter] GitHub API error:", resp.status, errBody);
          if (resp.status === 401) {
            localStorage.removeItem("remux-github-token");
            fetch("/api/auth/github-token", {
              method: "DELETE",
              headers: getRemuxAuthHeaders(),
            }).catch(() => {});
          }
          return { ok: false, error: `GitHub API ${resp.status}` };
        }

        const issue = await resp.json() as { number?: number; html_url?: string };
        console.log("[github-adapter] issue created:", issue.number);
        return { ok: true, deliveryId: String(issue.number ?? ""), deliveryUrl: issue.html_url };
      } catch (err) {
        console.error("[github-adapter] unexpected error:", err);
        return { ok: false, error: String(err) };
      }
    },
  };
}

initSnapfeed({
  endpoint: "/api/telemetry/events",
  trackClicks: true, trackNavigation: true, trackErrors: true,
  trackApiErrors: true, captureConsoleErrors: true,
  feedback: {
    enabled: true, screenshotMaxWidth: 1200, screenshotQuality: 0.6,
    annotations: true, allowContextToggle: true, allowScreenshotToggle: true,
    defaultIncludeContext: true, defaultIncludeScreenshot: false,
  },
  adapters: [lazyGithubAdapter() as never],
});

createRoot(document.getElementById("root")!).render(<App />);
