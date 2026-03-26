import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const crateDir = path.join(repoRoot, "native", "zellij-bridge");
const sourceBinaryName = process.platform === "win32" ? "zellij-bridge.exe" : "zellij-bridge";
const packagedBinaryName = process.platform === "win32" ? "remux-zellij-bridge.exe" : "remux-zellij-bridge";
const builtBinary = path.join(crateDir, "target", "release", sourceBinaryName);
const outputDir = path.join(repoRoot, "dist", "backend", "zellij");
const outputBinary = path.join(outputDir, packagedBinaryName);

const cargoVersion = spawnSync("cargo", ["--version"], {
  cwd: repoRoot,
  stdio: "pipe",
  encoding: "utf8"
});

if (cargoVersion.error || cargoVersion.status !== 0) {
  console.warn("[build:zellij-bridge] cargo not available, skipping native bridge build");
  process.exit(0);
}

const buildResult = spawnSync("cargo", ["build", "--manifest-path", path.join(crateDir, "Cargo.toml"), "--release"], {
  cwd: repoRoot,
  stdio: "inherit"
});

if (buildResult.status !== 0) {
  process.exit(buildResult.status ?? 1);
}

fs.mkdirSync(outputDir, { recursive: true });
fs.rmSync(path.join(outputDir, sourceBinaryName), { force: true });
fs.copyFileSync(builtBinary, outputBinary);
if (process.platform !== "win32") {
  fs.chmodSync(outputBinary, 0o755);
}
