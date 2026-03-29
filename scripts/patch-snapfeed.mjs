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

  for (const replacement of replacements) {
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
