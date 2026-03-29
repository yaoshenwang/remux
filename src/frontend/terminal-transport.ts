import type { TerminalPatchMessage } from "../shared/protocol.js";

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isOptionalFiniteNumber = (value: unknown): value is number =>
  value === undefined || (typeof value === "number" && Number.isFinite(value));

export const parseTerminalPatchMessage = (raw: string): TerminalPatchMessage | null => {
  if (!raw.startsWith("{")) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isObject(parsed) || parsed.type !== "terminal_patch") {
      return null;
    }
    if (
      typeof parsed.paneId !== "string"
      || typeof parsed.viewRevision !== "number"
      || !Number.isFinite(parsed.viewRevision)
      || typeof parsed.revision !== "number"
      || !Number.isFinite(parsed.revision)
      || !(parsed.baseRevision === null || (typeof parsed.baseRevision === "number" && Number.isFinite(parsed.baseRevision)))
      || typeof parsed.reset !== "boolean"
      || (parsed.source !== "snapshot" && parsed.source !== "stream")
      || typeof parsed.dataBase64 !== "string"
      || !isOptionalFiniteNumber(parsed.cols)
      || !isOptionalFiniteNumber(parsed.rows)
    ) {
      return null;
    }
    return {
      type: "terminal_patch",
      paneId: parsed.paneId,
      viewRevision: parsed.viewRevision,
      revision: parsed.revision,
      baseRevision: parsed.baseRevision,
      reset: parsed.reset,
      source: parsed.source,
      dataBase64: parsed.dataBase64,
      ...(typeof parsed.cols === "number" ? { cols: parsed.cols } : {}),
      ...(typeof parsed.rows === "number" ? { rows: parsed.rows } : {}),
    };
  } catch {
    return null;
  }
};

export const decodeTerminalPatchData = (message: TerminalPatchMessage): Uint8Array => {
  const decoded = atob(message.dataBase64);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return bytes;
};

export const resolveTerminalPatchDisposition = (
  message: TerminalPatchMessage,
  activeViewRevision: number | null | undefined,
  lastAppliedRevision: number | null | undefined,
): { apply: boolean; reason: "ok" | "stale_view" | "revision_gap" } => {
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
  lastAppliedRevision?: number | null,
): boolean =>
  resolveTerminalPatchDisposition(message, activeViewRevision, lastAppliedRevision).apply;

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
