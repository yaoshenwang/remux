import type { ClientDiagnosticDetails, TerminalPatchMessage } from "../shared/protocol.js";

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isOptionalFiniteNumber = (value: unknown): value is number =>
  value === undefined || (typeof value === "number" && Number.isFinite(value));

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

const parsePatchPayload = (value: unknown): TerminalPatchMessage["payload"] | null | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (!isObject(value)) {
    return null;
  }
  if (
    (value.encoding !== undefined && typeof value.encoding !== "string")
    || (value.chunksBase64 !== undefined && !isStringArray(value.chunksBase64))
    || (value.chunkBase64 !== undefined && typeof value.chunkBase64 !== "string")
    || (value.dataBase64 !== undefined && typeof value.dataBase64 !== "string")
  ) {
    return null;
  }
  return {
    ...(typeof value.encoding === "string" ? { encoding: value.encoding } : {}),
    ...(isStringArray(value.chunksBase64) ? { chunksBase64: value.chunksBase64 } : {}),
    ...(typeof value.chunkBase64 === "string" ? { chunkBase64: value.chunkBase64 } : {}),
    ...(typeof value.dataBase64 === "string" ? { dataBase64: value.dataBase64 } : {}),
  };
};

const hasDecodablePatchPayload = (payload: TerminalPatchMessage["payload"]): boolean => {
  if (!payload) {
    return false;
  }
  return (
    (Array.isArray(payload.chunksBase64) && payload.chunksBase64.length > 0)
    || typeof payload.chunkBase64 === "string"
    || typeof payload.dataBase64 === "string"
  );
};

export const parseTerminalPatchMessage = (raw: string): TerminalPatchMessage | null => {
  if (!raw.startsWith("{")) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isObject(parsed) || parsed.type !== "terminal_patch") {
      return null;
    }
    const payload = parsePatchPayload(parsed.payload);
    const hasLegacyData = typeof parsed.dataBase64 === "string";
    if (
      typeof parsed.paneId !== "string"
      || typeof parsed.epoch !== "number"
      || !Number.isFinite(parsed.epoch)
      || typeof parsed.viewRevision !== "number"
      || !Number.isFinite(parsed.viewRevision)
      || typeof parsed.revision !== "number"
      || !Number.isFinite(parsed.revision)
      || !(parsed.baseRevision === null || (typeof parsed.baseRevision === "number" && Number.isFinite(parsed.baseRevision)))
      || typeof parsed.reset !== "boolean"
      || (parsed.source !== "snapshot" && parsed.source !== "stream")
      || (parsed.dataBase64 !== undefined && typeof parsed.dataBase64 !== "string")
      || payload === null
      || (!hasLegacyData && !hasDecodablePatchPayload(payload))
      || !isOptionalFiniteNumber(parsed.cols)
      || !isOptionalFiniteNumber(parsed.rows)
    ) {
      return null;
    }
    return {
      type: "terminal_patch",
      paneId: parsed.paneId,
      epoch: parsed.epoch,
      viewRevision: parsed.viewRevision,
      revision: parsed.revision,
      baseRevision: parsed.baseRevision,
      reset: parsed.reset,
      source: parsed.source,
      ...(payload ? { payload } : {}),
      ...(typeof parsed.dataBase64 === "string" ? { dataBase64: parsed.dataBase64 } : {}),
      ...(typeof parsed.cols === "number" ? { cols: parsed.cols } : {}),
      ...(typeof parsed.rows === "number" ? { rows: parsed.rows } : {}),
    };
  } catch {
    return null;
  }
};

const decodeBase64 = (base64: string): Uint8Array => {
  const decoded = atob(base64);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return bytes;
};

const decodePayloadData = (payload: TerminalPatchMessage["payload"]): Uint8Array | null => {
  if (!payload) {
    return null;
  }
  try {
    if (Array.isArray(payload.chunksBase64) && payload.chunksBase64.length > 0) {
      const chunks = payload.chunksBase64.map((chunk) => decodeBase64(chunk));
      const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const merged = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      return merged;
    }
    if (typeof payload.chunkBase64 === "string") {
      return decodeBase64(payload.chunkBase64);
    }
    if (typeof payload.dataBase64 === "string") {
      return decodeBase64(payload.dataBase64);
    }
  } catch {
    return null;
  }
  return null;
};

export const decodeTerminalPatchData = (message: TerminalPatchMessage): Uint8Array => {
  const structured = decodePayloadData(message.payload);
  if (structured) {
    return structured;
  }
  if (typeof message.dataBase64 === "string") {
    return decodeBase64(message.dataBase64);
  }
  return new Uint8Array(0);
};

export const resolveTerminalPatchDisposition = (
  message: TerminalPatchMessage,
  activeViewRevision: number | null | undefined,
  activeEpoch: number | null | undefined,
  lastAppliedRevision: number | null | undefined,
): { apply: boolean; reason: "ok" | "stale_view" | "epoch_gap" | "revision_gap" } => {
  if (
    typeof activeViewRevision === "number"
    && Number.isFinite(activeViewRevision)
    && message.viewRevision !== activeViewRevision
  ) {
    return { apply: false, reason: "stale_view" };
  }
  if (message.reset) {
    return { apply: true, reason: "ok" };
  }
  if (
    typeof activeEpoch === "number"
    && Number.isFinite(activeEpoch)
    && message.epoch !== activeEpoch
  ) {
    return { apply: false, reason: "epoch_gap" };
  }
  if (typeof lastAppliedRevision === "number" && Number.isFinite(lastAppliedRevision)) {
    return message.baseRevision === lastAppliedRevision
      ? { apply: true, reason: "ok" }
      : { apply: false, reason: "revision_gap" };
  }
  return message.baseRevision === null
    ? { apply: true, reason: "ok" }
    : { apply: false, reason: "revision_gap" };
};

export const shouldApplyTerminalPatch = (
  message: TerminalPatchMessage,
  activeViewRevision: number | null | undefined,
  activeEpoch: number | null | undefined,
  lastAppliedRevision?: number | null,
): boolean =>
  resolveTerminalPatchDisposition(message, activeViewRevision, activeEpoch, lastAppliedRevision).apply;

export const resolveTerminalBaseRevision = (
  activeViewRevision: number | null | undefined,
  lastAppliedViewRevision: number | null | undefined,
  lastAppliedRevision: number | null | undefined,
): number | undefined => {
  if (
    typeof activeViewRevision !== "number"
    || !Number.isFinite(activeViewRevision)
    || typeof lastAppliedViewRevision !== "number"
    || !Number.isFinite(lastAppliedViewRevision)
    || activeViewRevision !== lastAppliedViewRevision
    || typeof lastAppliedRevision !== "number"
    || !Number.isFinite(lastAppliedRevision)
    || lastAppliedRevision < 0
  ) {
    return undefined;
  }
  return lastAppliedRevision;
};

export const buildTerminalPatchDropDiagnostic = (
  message: TerminalPatchMessage,
  reason: "stale_view" | "epoch_gap" | "revision_gap",
  activeViewRevision: number | null | undefined,
  activeEpoch: number | null | undefined,
): ClientDiagnosticDetails => ({
  issue: "revision_mismatch",
  severity: reason === "stale_view" ? "warn" : "error",
  status: "open",
  summary: reason === "stale_view"
    ? `Dropped terminal patch ${message.revision} from stale view revision ${message.viewRevision}`
    : reason === "epoch_gap"
      ? `Dropped terminal patch ${message.revision} after epoch gap ${message.epoch}`
      : `Dropped terminal patch ${message.revision} after revision gap from ${String(message.baseRevision)}`,
  sample: {
    viewRevision: typeof activeViewRevision === "number" ? activeViewRevision : undefined,
    terminalEpoch: typeof activeEpoch === "number" ? activeEpoch : undefined,
    backendCols: message.cols,
    backendRows: message.rows,
  },
  recentActions: [],
  recentSamples: [
    {
      viewRevision: message.viewRevision,
      terminalEpoch: message.epoch,
      backendCols: message.cols,
      backendRows: message.rows,
    },
  ],
});
