import type { InspectRequest, InspectSnapshot } from "./types.js";

const CACHE_PREFIX = "remux-inspect-cache";
const CACHE_VERSION = 1;
const CACHE_VERSION_KEY = `${CACHE_PREFIX}:version`;
const CACHE_INDEX_KEY = `${CACHE_PREFIX}:index`;
const CACHE_LIMIT_BYTES = 5 * 1024 * 1024;

interface InspectCacheEntry {
  key: string;
  size: number;
  updatedAt: string;
}

interface InspectCacheEnvelope {
  version: number;
  snapshot: InspectSnapshot;
}

const canUseLocalStorage = (): boolean => typeof window !== "undefined" && !!window.localStorage;

const ensureCacheVersion = (): void => {
  if (!canUseLocalStorage()) {
    return;
  }

  const version = window.localStorage.getItem(CACHE_VERSION_KEY);
  if (version === String(CACHE_VERSION)) {
    return;
  }

  const keysToDelete: string[] = [];
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (!key?.startsWith(CACHE_PREFIX)) {
      continue;
    }
    keysToDelete.push(key);
  }
  keysToDelete.forEach((key) => window.localStorage.removeItem(key));
  window.localStorage.setItem(CACHE_VERSION_KEY, String(CACHE_VERSION));
};

const readCacheIndex = (): InspectCacheEntry[] => {
  if (!canUseLocalStorage()) {
    return [];
  }

  ensureCacheVersion();
  try {
    const raw = window.localStorage.getItem(CACHE_INDEX_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as InspectCacheEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const writeCacheIndex = (entries: InspectCacheEntry[]): void => {
  if (!canUseLocalStorage()) {
    return;
  }
  window.localStorage.setItem(CACHE_INDEX_KEY, JSON.stringify(entries));
};

const estimateBytes = (value: string): number => new Blob([value]).size;

export const buildInspectCacheBucketKey = (
  sessionName: string,
  request: Pick<InspectRequest, "scope" | "paneId" | "tabIndex">,
): string => {
  const tabKey = request.tabIndex ?? "active";
  const paneKey = request.paneId ?? "all";
  return `${CACHE_PREFIX}:${sessionName}:${request.scope}:${tabKey}:${paneKey}`;
};

export const readInspectCache = (key: string): InspectSnapshot | null => {
  if (!canUseLocalStorage()) {
    return null;
  }

  ensureCacheVersion();
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return null;
    }
    const payload = JSON.parse(raw) as InspectCacheEnvelope;
    if (payload.version !== CACHE_VERSION || !payload.snapshot) {
      window.localStorage.removeItem(key);
      return null;
    }
    return payload.snapshot;
  } catch {
    window.localStorage.removeItem(key);
    return null;
  }
};

export const writeInspectCache = (key: string, snapshot: InspectSnapshot): void => {
  if (!canUseLocalStorage()) {
    return;
  }

  ensureCacheVersion();
  const payload = JSON.stringify({
    version: CACHE_VERSION,
    snapshot,
  } satisfies InspectCacheEnvelope);
  const size = estimateBytes(payload);

  if (size > CACHE_LIMIT_BYTES) {
    return;
  }

  const entries = readCacheIndex().filter((entry) => entry.key !== key);
  entries.push({
    key,
    size,
    updatedAt: new Date().toISOString(),
  });
  entries.sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));

  let totalSize = entries.reduce((sum, entry) => sum + entry.size, 0);
  while (totalSize > CACHE_LIMIT_BYTES && entries.length > 0) {
    const oldest = entries.shift();
    if (!oldest) {
      break;
    }
    totalSize -= oldest.size;
    window.localStorage.removeItem(oldest.key);
  }

  window.localStorage.setItem(key, payload);
  writeCacheIndex(entries);
};

export const toLocalCacheSnapshot = (snapshot: InspectSnapshot): InspectSnapshot => ({
  ...snapshot,
  descriptor: {
    ...snapshot.descriptor,
    source: "local_cache",
    staleness: snapshot.descriptor.staleness === "fresh" ? "stale" : snapshot.descriptor.staleness,
  },
});
