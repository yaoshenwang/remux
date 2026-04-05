import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");

export function releaseTagForVersion(version) {
  return version.startsWith("v") ? version : `v${version}`;
}

export function evaluateExpectedAssets(expectedAssetNames, existingAssetNames) {
  const expected = [...expectedAssetNames];
  const existing = [...existingAssetNames];
  const existingSet = new Set(existing);
  const expectedSet = new Set(expected);

  return {
    expectedAssetNames: expected,
    existingAssetNames: existing,
    missingAssetNames: expected.filter((assetName) => !existingSet.has(assetName)),
    unexpectedAssetNames: existing.filter((assetName) => !expectedSet.has(assetName)),
    isComplete: expected.every((assetName) => existingSet.has(assetName)),
  };
}

export function findMissingDocSnippets(content, snippets) {
  return snippets.filter((snippet) => !content.includes(snippet));
}

export function isAllowedExternalBuildState(state) {
  return state === "IN_BETA_TESTING" || state === "READY_FOR_BETA_TESTING";
}

export function findPublicLinkGroup(groups, publicLink) {
  return groups.find((group) => group?.attributes?.publicLink === publicLink) ?? null;
}

export function loadReleaseReadinessConfig(configPath = path.join(REPO_ROOT, "scripts", "release-readiness.config.json")) {
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

export function loadPackageVersion(packageJsonPath = path.join(REPO_ROOT, "package.json")) {
  return JSON.parse(fs.readFileSync(packageJsonPath, "utf8")).version;
}

export async function fetchJson(url, { headers = {} } = {}) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "remux-release-readiness",
      ...headers,
    },
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(`${url} -> ${response.status} ${response.statusText}`);
  }

  return response.json();
}

export async function fetchText(url, { headers = {} } = {}) {
  const response = await fetch(url, {
    headers: {
      Accept: "*/*",
      "User-Agent": "remux-release-readiness",
      ...headers,
    },
    redirect: "follow",
  });

  const text = await response.text();
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    url: response.url,
    text,
  };
}

export function createAscJwt({
  issuerId,
  keyId,
  privateKeyPem,
  now = Math.floor(Date.now() / 1000),
}) {
  const header = { alg: "ES256", kid: keyId, typ: "JWT" };
  const payload = {
    iss: issuerId,
    iat: now,
    exp: now + 1200,
    aud: "appstoreconnect-v1",
  };

  const base64Url = (value) =>
    Buffer.from(JSON.stringify(value))
      .toString("base64url");

  const signingInput = `${base64Url(header)}.${base64Url(payload)}`;
  const signature = crypto.sign("sha256", Buffer.from(signingInput), {
    key: privateKeyPem,
    dsaEncoding: "ieee-p1363",
  });

  return `${signingInput}.${signature.toString("base64url")}`;
}

export function readAscPrivateKeyFromEnv(env = process.env) {
  if (env.APP_STORE_CONNECT_API_KEY_P8?.trim()) {
    return env.APP_STORE_CONNECT_API_KEY_P8;
  }

  if (env.APP_STORE_CONNECT_API_KEY_P8_BASE64?.trim()) {
    return Buffer.from(env.APP_STORE_CONNECT_API_KEY_P8_BASE64, "base64").toString("utf8");
  }

  return null;
}

export async function fetchAscJson(url, token) {
  return fetchJson(url, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
}
