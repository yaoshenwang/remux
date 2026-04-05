#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  evaluateExpectedAssets,
  fetchJson,
  fetchSha256,
  fetchText,
  findMissingDocSnippets,
  loadPackageVersion,
  loadReleaseReadinessConfig,
  releaseTagForVersion,
} from "./lib/release-readiness.mjs";
import { smokeNpmPackageSpec } from "./lib/package-smoke.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const args = {
    channel: "stable",
    mode: "all",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--channel") args.channel = argv[index + 1];
    if (arg === "--mode") args.mode = argv[index + 1];
  }

  return args;
}

function pushResult(results, result) {
  results.push(result);
}

async function runDocsChecks(config, results) {
  for (const documentConfig of config.documentation) {
    const absolutePath = path.join(REPO_ROOT, documentConfig.path);
    const content = await fs.readFile(absolutePath, "utf8");
    const missingSnippets = findMissingDocSnippets(content, documentConfig.requiredSnippets);

    pushResult(results, {
      key: `docs:${documentConfig.path}`,
      ok: missingSnippets.length === 0,
      detail:
        missingSnippets.length === 0
          ? "documentation snippets present"
          : `missing snippets: ${missingSnippets.join(", ")}`,
    });
  }
}

async function runPublicChecks(config, version, results) {
  const expectedTag = releaseTagForVersion(version);

  const webResponse = await fetchText(config.web.url);
  pushResult(results, {
    key: "web",
    ok: webResponse.ok && webResponse.text.includes(config.web.requiredBodySnippet),
    detail: `${webResponse.status} ${webResponse.url}`,
  });

  const npmMetadata = await fetchJson(`https://registry.npmjs.org/${encodeURIComponent(config.npm.packageName)}`);
  const distTagVersion = npmMetadata["dist-tags"]?.[config.npm.distTag];
  const tarballUrl = npmMetadata.versions?.[distTagVersion]?.dist?.tarball;
  const tarballDownload = tarballUrl ? await fetchSha256(tarballUrl) : null;
  pushResult(results, {
    key: "npm",
    ok: distTagVersion === version && tarballDownload?.ok === true,
    detail: `${config.npm.distTag}=${distTagVersion ?? "missing"}`,
  });
  let npmInstallFailure = null;
  if (distTagVersion === version) {
    try {
      await smokeNpmPackageSpec(`${config.npm.packageName}@${version}`, { cwd: REPO_ROOT });
    } catch (error) {
      npmInstallFailure = error;
    }
  }
  pushResult(results, {
    key: "npm-install",
    ok: distTagVersion === version && npmInstallFailure === null,
    detail: distTagVersion !== version
      ? `${config.npm.distTag} resolves to ${distTagVersion ?? "missing"} instead of ${version}`
      : npmInstallFailure === null
        ? `installed ${config.npm.packageName}@${version} from npm and reached the served UI`
        : npmInstallFailure.message.split("\n")[0],
  });

  const latestRelease = await fetchJson(`https://api.github.com/repos/${config.github.repository}/releases/latest`);
  const assetCoverage = evaluateExpectedAssets(
    config.macos.expectedAssetNames,
    latestRelease.assets.map((asset) => asset.name),
  );
  pushResult(results, {
    key: "github-release",
    ok: latestRelease.tag_name === expectedTag && assetCoverage.isComplete,
    detail: `tag=${latestRelease.tag_name}, missing=${assetCoverage.missingAssetNames.join(", ") || "none"}`,
  });

  const dmgDownload = await fetchSha256(config.macos.latestDownloadUrl);
  const appcastResponse = await fetchText(config.macos.appcastUrl);
  const remoteManifestAsset = latestRelease.assets.find((asset) => asset.name === "remuxd-remote-manifest.json");
  const remoteManifest = remoteManifestAsset ? await fetchJson(remoteManifestAsset.browser_download_url) : null;
  const expectedRemoteTargets = [
    "darwin/arm64",
    "darwin/amd64",
    "linux/arm64",
    "linux/amd64",
  ];
  const actualRemoteTargets = new Set(
    (remoteManifest?.entries ?? []).map((entry) => `${entry.goOS}/${entry.goArch}`),
  );
  const missingRemoteTargets = expectedRemoteTargets.filter((target) => !actualRemoteTargets.has(target));
  pushResult(results, {
    key: "macos-download",
    ok: dmgDownload.ok,
    detail: `${dmgDownload.status} ${dmgDownload.url}`,
  });
  pushResult(results, {
    key: "macos-appcast",
    ok: appcastResponse.ok && appcastResponse.text.includes("<rss"),
    detail: `${appcastResponse.status} ${appcastResponse.url}`,
  });
  pushResult(results, {
    key: "macos-remote-daemon-manifest",
    ok:
      Boolean(remoteManifest) &&
      remoteManifest.releaseTag === expectedTag &&
      missingRemoteTargets.length === 0,
    detail: remoteManifest
      ? `tag=${remoteManifest.releaseTag}, missing=${missingRemoteTargets.join(", ") || "none"}`
      : "remote daemon manifest missing",
  });

}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadReleaseReadinessConfig()[args.channel];
  const version = loadPackageVersion();
  const results = [];

  if (!config) {
    throw new Error(`unknown channel: ${args.channel}`);
  }

  if (args.mode === "docs" || args.mode === "all") {
    await runDocsChecks(config, results);
  }

  if (args.mode === "public" || args.mode === "all") {
    await runPublicChecks(config, version, results);
  }

  let failed = false;
  for (const result of results) {
    const prefix = result.ok ? "PASS" : "FAIL";
    console.log(`[${prefix}] ${result.key}: ${result.detail}`);
    if (!result.ok) failed = true;
  }

  if (failed) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`[FAIL] release-readiness: ${error.message}`);
  process.exitCode = 1;
});
