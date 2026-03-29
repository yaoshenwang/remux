import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initSnapfeed } from "@microsoft/snapfeed";
import "@xterm/xterm/css/xterm.css";
import "./styles/app.css";
import { createLazyGithubAdapter } from "./feedback/github-adapter";
import { token as remuxToken } from "./remux-runtime";

initSnapfeed({
  endpoint: "/api/telemetry/events",
  trackClicks: true, trackNavigation: true, trackErrors: true,
  trackApiErrors: true, captureConsoleErrors: true,
  feedback: {
    enabled: true, screenshotMaxWidth: 1200, screenshotQuality: 0.6,
    // Screenshot capture stays off until snapfeed/html2canvas handles color() reliably.
    annotations: false, allowContextToggle: true, allowScreenshotToggle: false,
    defaultIncludeContext: true, defaultIncludeScreenshot: false,
  },
  adapters: [createLazyGithubAdapter({ authToken: remuxToken }) as never],
});

createRoot(document.getElementById("root")!).render(<App />);
