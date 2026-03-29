import type { ServerConfig } from "./app-types";

export const BUILD_GUARD_RELOAD_TOKEN_KEY = "remux-build-reload-token";
const DEFAULT_POLL_INTERVAL_MS = 30_000;
const VERSION_RELOAD_MESSAGE = "A newer Remux build is available. Reloading…";
const CHUNK_RELOAD_MESSAGE = "Remux assets went stale after a deploy. Reloading…";

type BuildGuardEventType = "error" | "unhandledrejection" | "visibilitychange";
type BuildGuardListener = (event: unknown) => void;

export interface BuildGuardBrowser {
  addEventListener(type: BuildGuardEventType, listener: BuildGuardListener): void;
  removeEventListener(type: BuildGuardEventType, listener: BuildGuardListener): void;
  document: {
    visibilityState?: string;
  };
}

export interface BuildGuardStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface BuildGuardTimerApi {
  clearInterval(id: unknown): void;
  setInterval(callback: () => void, intervalMs: number): unknown;
}

export interface FrontendBuildGuard {
  start(initialConfig: ServerConfig): void;
  stop(): void;
}

export interface CreateFrontendBuildGuardOptions {
  browser: BuildGuardBrowser;
  fetchConfig: () => Promise<ServerConfig>;
  onReload: () => void;
  onStatusMessage?: (message: string) => void;
  pollIntervalMs?: number;
  storage?: BuildGuardStorage;
  timers?: BuildGuardTimerApi;
}

const DYNAMIC_IMPORT_FAILURE_PATTERNS = [
  /Failed to fetch dynamically imported module/i,
  /Importing a module script failed/i,
  /Loading chunk [\w-]+ failed/i,
  /ChunkLoadError/i,
] as const;

const getMessageFromUnknown = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Error) {
    return value.message;
  }
  if (!value || typeof value !== "object") {
    return "";
  }
  if ("message" in value && typeof value.message === "string") {
    return value.message;
  }
  return "";
};

const extractFailureReason = (event: unknown): unknown => {
  if (!event || typeof event !== "object") {
    return event;
  }
  if ("reason" in event) {
    return event.reason;
  }
  if ("error" in event && event.error) {
    return event.error;
  }
  if ("message" in event && typeof event.message === "string") {
    return event.message;
  }
  return event;
};

export const deriveBuildFingerprint = (config: Pick<ServerConfig, "gitCommitSha" | "version"> | null | undefined): string | null => {
  const gitCommitSha = config?.gitCommitSha?.trim();
  if (gitCommitSha) {
    return gitCommitSha;
  }
  const version = config?.version?.trim();
  return version ? `version:${version}` : null;
};

export const isDynamicImportFailure = (value: unknown): boolean => {
  const message = getMessageFromUnknown(value);
  if (!message) {
    return false;
  }
  return DYNAMIC_IMPORT_FAILURE_PATTERNS.some((pattern) => pattern.test(message));
};

export const createFrontendBuildGuard = ({
  browser,
  fetchConfig,
  onReload,
  onStatusMessage,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  storage,
  timers = {
    clearInterval: (id) => clearInterval(id as ReturnType<typeof setInterval>),
    setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
  },
}: CreateFrontendBuildGuardOptions): FrontendBuildGuard => {
  let baselineFingerprint: string | null = null;
  let intervalId: unknown = null;
  let started = false;
  let checkingPromise: Promise<void> | null = null;
  let reloadRequested = false;

  const requestReload = (token: string, message: string): void => {
    if (reloadRequested) {
      return;
    }
    if (storage?.getItem(BUILD_GUARD_RELOAD_TOKEN_KEY) === token) {
      return;
    }
    storage?.setItem(BUILD_GUARD_RELOAD_TOKEN_KEY, token);
    reloadRequested = true;
    onStatusMessage?.(message);
    onReload();
  };

  const checkForBuildUpdate = (fallbackToChunkReload: boolean): Promise<void> => {
    if (checkingPromise) {
      return checkingPromise;
    }
    checkingPromise = (async () => {
      try {
        const nextConfig = await fetchConfig();
        const nextFingerprint = deriveBuildFingerprint(nextConfig);
        if (baselineFingerprint && nextFingerprint && nextFingerprint !== baselineFingerprint) {
          requestReload(nextFingerprint, VERSION_RELOAD_MESSAGE);
          return;
        }
        if (fallbackToChunkReload) {
          requestReload(`chunk:${baselineFingerprint ?? nextFingerprint ?? "unknown"}`, CHUNK_RELOAD_MESSAGE);
        }
      } catch {
        if (fallbackToChunkReload) {
          requestReload(`chunk:${baselineFingerprint ?? "unknown"}`, CHUNK_RELOAD_MESSAGE);
        }
      } finally {
        checkingPromise = null;
      }
    })();
    return checkingPromise;
  };

  const handleChunkFailure = (event: unknown): void => {
    if (!isDynamicImportFailure(extractFailureReason(event))) {
      return;
    }
    void checkForBuildUpdate(true);
  };

  const handleVisibilityChange = (): void => {
    if (browser.document.visibilityState === "hidden") {
      return;
    }
    void checkForBuildUpdate(false);
  };

  return {
    start(initialConfig): void {
      baselineFingerprint = deriveBuildFingerprint(initialConfig);
      if (baselineFingerprint && storage?.getItem(BUILD_GUARD_RELOAD_TOKEN_KEY) === baselineFingerprint) {
        storage.removeItem(BUILD_GUARD_RELOAD_TOKEN_KEY);
      }
      if (started) {
        return;
      }
      started = true;
      browser.addEventListener("error", handleChunkFailure);
      browser.addEventListener("unhandledrejection", handleChunkFailure);
      browser.addEventListener("visibilitychange", handleVisibilityChange);
      intervalId = timers.setInterval(() => {
        if (browser.document.visibilityState === "hidden") {
          return;
        }
        void checkForBuildUpdate(false);
      }, pollIntervalMs);
    },
    stop(): void {
      if (!started) {
        return;
      }
      started = false;
      browser.removeEventListener("error", handleChunkFailure);
      browser.removeEventListener("unhandledrejection", handleChunkFailure);
      browser.removeEventListener("visibilitychange", handleVisibilityChange);
      if (intervalId !== null) {
        timers.clearInterval(intervalId);
        intervalId = null;
      }
    },
  };
};
