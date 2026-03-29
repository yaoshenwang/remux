import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageDir = path.join(rootDir, "node_modules", "@microsoft", "snapfeed");
const packageJsonPath = path.join(packageDir, "package.json");
const supportedVersion = "0.1.0";

if (!fs.existsSync(packageJsonPath)) {
  console.warn("[patch-snapfeed] @microsoft/snapfeed is not installed; skipping patch.");
  process.exit(0);
}

const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
if (packageJson.version !== supportedVersion) {
  throw new Error(
    `[patch-snapfeed] Unsupported @microsoft/snapfeed version ${packageJson.version ?? "unknown"}. Expected ${supportedVersion}.`,
  );
}

// --- Backoff patch for flush retry logic ---
// Replaces fixed setInterval flushing with exponential backoff on failure:
// - After failure: interval doubles (3s -> 6s -> 12s -> ... -> 5min max)
// - After success: interval resets to base (3s)
// - After 20 consecutive failures: stops retrying entirely
// - Suppresses console errors after the first failure
const flushBackoffPatch = {
  from: [
    "var flushTimer = null;",
    "var config = null;",
  ].join("\n"),
  to: [
    "var flushTimer = null;",
    "var config = null;",
    "var _backoffMs = 0;",
    "var _consecutiveFailures = 0;",
    "var _maxConsecutiveFailures = 20;",
    "var _maxBackoffMs = 5 * 60 * 1000;",
    "var _errorLogged = false;",
  ].join("\n"),
};

const flushFnPatch = {
  from: [
    "async function flush() {",
    "  if (!config || queue.length === 0) return true;",
    "  const batch = queue.splice(0, queue.length);",
    "  try {",
    "    const response = await fetch(config.endpoint, {",
    '      method: "POST",',
    '      headers: { "Content-Type": "application/json" },',
    "      body: JSON.stringify({ events: batch })",
    "    });",
    "    if (!response.ok) {",
    "      queue.unshift(...batch);",
    "      if (config && queue.length > config.maxQueueSize) queue.splice(config.maxQueueSize);",
    "      return false;",
    "    }",
    "    return true;",
    "  } catch {",
    "    queue.unshift(...batch);",
    "    if (config && queue.length > config.maxQueueSize) queue.splice(config.maxQueueSize);",
    "    return false;",
    "  }",
    "}",
  ].join("\n"),
  to: [
    "async function flush() {",
    "  if (!config || queue.length === 0) return true;",
    "  const batch = queue.splice(0, queue.length);",
    "  try {",
    "    const response = await fetch(config.endpoint, {",
    '      method: "POST",',
    '      headers: { "Content-Type": "application/json" },',
    "      body: JSON.stringify({ events: batch })",
    "    });",
    "    if (!response.ok) {",
    "      queue.unshift(...batch);",
    "      if (config && queue.length > config.maxQueueSize) queue.splice(config.maxQueueSize);",
    "      _consecutiveFailures++;",
    "      _backoffMs = Math.min((_backoffMs || config.flushIntervalMs) * 2, _maxBackoffMs);",
    "      return false;",
    "    }",
    "    _consecutiveFailures = 0;",
    "    _backoffMs = 0;",
    "    _errorLogged = false;",
    "    return true;",
    "  } catch (e) {",
    "    queue.unshift(...batch);",
    "    if (config && queue.length > config.maxQueueSize) queue.splice(config.maxQueueSize);",
    "    if (!_errorLogged) {",
    '      console.error("[snapfeed] flush failed:", e);',
    "      _errorLogged = true;",
    "    }",
    "    _consecutiveFailures++;",
    "    _backoffMs = Math.min((_backoffMs || config.flushIntervalMs) * 2, _maxBackoffMs);",
    "    return false;",
    "  }",
    "}",
  ].join("\n"),
};

const startFlushingPatch = {
  from: [
    "function startFlushing(resolvedConfig) {",
    "  config = resolvedConfig;",
    "  if (flushTimer) clearInterval(flushTimer);",
    "  flushTimer = setInterval(flush, config.flushIntervalMs);",
    "}",
    "function stopFlushing() {",
    "  if (flushTimer) {",
    "    clearInterval(flushTimer);",
    "    flushTimer = null;",
    "  }",
    "  flush();",
    "}",
  ].join("\n"),
  to: [
    "function _scheduleFlush() {",
    "  if (_consecutiveFailures >= _maxConsecutiveFailures) return;",
    "  var delay = _backoffMs || config.flushIntervalMs;",
    "  flushTimer = setTimeout(async function() {",
    "    await flush();",
    "    _scheduleFlush();",
    "  }, delay);",
    "}",
    "function startFlushing(resolvedConfig) {",
    "  config = resolvedConfig;",
    "  _consecutiveFailures = 0;",
    "  _backoffMs = 0;",
    "  _errorLogged = false;",
    "  if (flushTimer) clearTimeout(flushTimer);",
    "  _scheduleFlush();",
    "}",
    "function stopFlushing() {",
    "  if (flushTimer) {",
    "    clearTimeout(flushTimer);",
    "    flushTimer = null;",
    "  }",
    "  flush();",
    "}",
  ].join("\n"),
};

const backoffReplacements = [flushBackoffPatch, flushFnPatch, startFlushingPatch];

const replacements = [
  {
    from: [
      "  const screenshotControlVisible = allowScreenshotToggle || feedbackConfig.annotations;",
      "  const contextControlVisible = allowContextToggle;",
      "  const viewport = getViewportBounds();",
      "  const dialogWidth = Math.min(420, Math.max(220, viewport.width - OVERLAY_MARGIN * 2));",
      "  pendingScreenshot = captureScreenshot(x, y);",
    ].join("\n"),
    to: [
      "  const screenshotControlVisible = allowScreenshotToggle || feedbackConfig.annotations;",
      "  const contextControlVisible = allowContextToggle;",
      "  const screenshotCaptureEnabled = feedbackConfig.defaultIncludeScreenshot || allowScreenshotToggle || feedbackConfig.annotations;",
      "  const viewport = getViewportBounds();",
      "  const dialogWidth = Math.min(420, Math.max(220, viewport.width - OVERLAY_MARGIN * 2));",
      "  pendingScreenshot = screenshotCaptureEnabled ? captureScreenshot(x, y) : Promise.resolve(null);",
    ].join("\n"),
  },
  {
    from: [
      "    if (!includeScreenshot) {",
      '      updateStatus("Screenshot will be skipped for this report.");',
      "      schedulePosition();",
      "      return;",
      "    }",
    ].join("\n"),
    to: [
      "    if (!includeScreenshot) {",
      '      updateStatus(screenshotControlVisible ? "Screenshot will be skipped for this report." : includeContext ? "Page context will be attached to this report." : "");',
      "      schedulePosition();",
      "      return;",
      "    }",
    ].join("\n"),
  },
];

const patchFile = (relativePath) => {
  const filePath = path.join(packageDir, relativePath);
  let contents = fs.readFileSync(filePath, "utf8");
  let changed = false;

  for (const replacement of [...backoffReplacements, ...replacements]) {
    if (contents.includes(replacement.to)) {
      continue;
    }
    if (!contents.includes(replacement.from)) {
      throw new Error(`[patch-snapfeed] Could not find patch target in ${relativePath}.`);
    }
    contents = contents.replace(replacement.from, replacement.to);
    changed = true;
  }

  if (changed) {
    fs.writeFileSync(filePath, contents);
    console.log(`[patch-snapfeed] patched ${relativePath}`);
  }
};

patchFile("dist/index.js");
patchFile("dist/index.cjs");
