#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createAscJwt,
  evaluateExpectedAssets,
  fetchAscJson,
  fetchJson,
  fetchText,
  findMissingDocSnippets,
  findPublicLinkGroup,
  isAllowedExternalBuildState,
  loadPackageVersion,
  loadReleaseReadinessConfig,
  readAscPrivateKeyFromEnv,
  releaseTagForVersion,
} from "./lib/release-readiness.mjs";

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
  const tarballResponse = tarballUrl ? await fetchText(tarballUrl) : null;
  pushResult(results, {
    key: "npm",
    ok: distTagVersion === version && tarballResponse?.ok === true,
    detail: `${config.npm.distTag}=${distTagVersion ?? "missing"}`,
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

  const dmgResponse = await fetchText(config.macos.latestDownloadUrl);
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
    ok: dmgResponse.ok,
    detail: `${dmgResponse.status} ${dmgResponse.url}`,
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

  if (config.macos.homebrew) {
    const caskResponse = await fetchText(config.macos.homebrew.caskRawUrl);
    const formulaResponse = await fetchText(config.macos.homebrew.formulaRawUrl);
    const caskOk =
      caskResponse.ok &&
      caskResponse.text.includes(`version "${version}"`) &&
      caskResponse.text.includes(config.macos.latestReleaseTagUrlTemplate);
    const formulaOk =
      formulaResponse.ok &&
      formulaResponse.text.includes(`url "https://registry.npmjs.org/@wangyaoshen/remux/-/remux-${version}.tgz"`) &&
      formulaResponse.text.includes('depends_on "node@24"');

    pushResult(results, {
      key: "homebrew-cask",
      ok: caskOk,
      detail: caskResponse.ok ? "tap cask matches current version" : `${caskResponse.status} ${config.macos.homebrew.caskRawUrl}`,
    });
    pushResult(results, {
      key: "homebrew-formula",
      ok: formulaOk,
      detail: formulaResponse.ok ? "tap formula matches current version" : `${formulaResponse.status} ${config.macos.homebrew.formulaRawUrl}`,
    });
  }

  const testFlightResponse = await fetchText(config.ios.publicLink);
  pushResult(results, {
    key: "ios-public-link",
    ok: testFlightResponse.ok && testFlightResponse.text.includes("TestFlight"),
    detail: `${testFlightResponse.status} ${testFlightResponse.url}`,
  });

  const ascPrivateKey = readAscPrivateKeyFromEnv();
  if (ascPrivateKey && process.env.APP_STORE_CONNECT_API_KEY_ID && process.env.APP_STORE_CONNECT_ISSUER_ID) {
    const ascToken = createAscJwt({
      issuerId: process.env.APP_STORE_CONNECT_ISSUER_ID,
      keyId: process.env.APP_STORE_CONNECT_API_KEY_ID,
      privateKeyPem: ascPrivateKey,
    });

    const betaGroups = await fetchAscJson(
      `https://api.appstoreconnect.apple.com/v1/betaGroups?filter[app]=${config.ios.appId}&limit=200`,
      ascToken,
    );
    const publicGroup = findPublicLinkGroup(betaGroups.data ?? [], config.ios.publicLink);
    const groupBuilds = publicGroup
      ? await fetchAscJson(
        `https://api.appstoreconnect.apple.com/v1/betaGroups/${publicGroup.id}/builds`,
        ascToken,
      )
      : { data: [] };

    const externalStates = [];
    for (const build of groupBuilds.data ?? []) {
      const buildBetaDetails = await fetchAscJson(
        `https://api.appstoreconnect.apple.com/v1/buildBetaDetails?filter[build]=${build.id}`,
        ascToken,
      );
      const externalState = buildBetaDetails.data?.[0]?.attributes?.externalBuildState;
      if (externalState) externalStates.push(externalState);
    }

    pushResult(results, {
      key: "ios-testflight",
      ok:
        Boolean(publicGroup?.attributes?.publicLinkEnabled) &&
        externalStates.some((state) => isAllowedExternalBuildState(state)),
      detail: publicGroup
        ? `group=${publicGroup.attributes.name}, states=${externalStates.join(", ") || "none"}`
        : "public beta group missing",
    });
  } else {
    pushResult(results, {
      key: "ios-testflight",
      ok: true,
      detail: "skipped App Store Connect state check (missing API env)",
    });
  }
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
