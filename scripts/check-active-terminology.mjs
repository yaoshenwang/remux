import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const entrypoints = ["README.md", "AGENTS.md", "docs", "src", "tests", ".github"];
const ignoredDirNames = new Set(["node_modules", "dist", ".git", "coverage"]);
const allowedExtensions = new Set([".md", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".yml", ".yaml"]);
const allowedFiles = new Map([
  ["docs/ACTIVE_DOCS_INDEX.md", "active index must point to the archived runtime-v2 document set by its real path"],
  ["docs/remux-zellij-master-plan-2026-v2.md", "current planning document compares legacy assumptions against the current baseline"],
  ["docs/LEGACY_PLAN_GAPS.md", "legacy gap ledger must name the invalidated assumptions"],
  ["docs/TERMINOLOGY_AUDIT.md", "audit output must record the archived terms it scanned"],
]);
const bannedPatterns = [
  { label: "runtime-v2", regex: /\bruntime-v2\b/gi },
  { label: "remuxd", regex: /\bremuxd\b/gi },
  { label: "old runtime", regex: /\bold runtime\b/gi },
  { label: "daemon", regex: /\bdaemon\b/gi },
];

async function collectFiles(relativePath) {
  const absolutePath = path.join(root, relativePath);
  const stats = await readdir(absolutePath, { withFileTypes: true }).catch(() => null);
  if (stats === null) {
    return [relativePath];
  }

  const files = [];
  for (const entry of stats) {
    if (ignoredDirNames.has(entry.name)) {
      continue;
    }

    const nextRelative = path.posix.join(relativePath, entry.name);
    if (nextRelative.startsWith("docs/archive/") || nextRelative.startsWith("docs/assets/")) {
      continue;
    }

    if (entry.isDirectory()) {
      files.push(...(await collectFiles(nextRelative)));
      continue;
    }

    if (allowedExtensions.has(path.extname(entry.name))) {
      files.push(nextRelative);
    }
  }

  return files;
}

async function main() {
  const files = [];
  for (const entrypoint of entrypoints) {
    const absolute = path.join(root, entrypoint);
    const isDirectory = await readdir(absolute, { withFileTypes: true }).then(() => true).catch(() => false);
    if (isDirectory) {
      files.push(...(await collectFiles(entrypoint)));
      continue;
    }

    files.push(entrypoint);
  }

  const violations = [];
  for (const relativePath of files) {
    if (allowedFiles.has(relativePath)) {
      continue;
    }

    const source = await readFile(path.join(root, relativePath), "utf8");
    const matchedLabels = bannedPatterns
      .filter(({ regex }) => regex.test(source))
      .map(({ label }) => label);

    if (matchedLabels.length > 0) {
      violations.push({ relativePath, matchedLabels });
    }
  }

  if (violations.length === 0) {
    console.log("Terminology guard passed.");
    return;
  }

  console.error("Archived-runtime terminology found in active files:");
  for (const violation of violations) {
    console.error(`- ${violation.relativePath}: ${violation.matchedLabels.join(", ")}`);
  }

  console.error("\nAllowed exceptions:");
  for (const [relativePath, reason] of allowedFiles.entries()) {
    console.error(`- ${relativePath}: ${reason}`);
  }

  process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
