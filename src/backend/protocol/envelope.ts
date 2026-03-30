export const REMUX_PROTOCOL_VERSION = 1 as const;

export const REMUX_DOMAINS = ["core", "runtime", "inspect", "admin"] as const;
export const ENVELOPE_SOURCES = ["server", "client"] as const;

export type RemuxDomain = (typeof REMUX_DOMAINS)[number];
export type EnvelopeSource = (typeof ENVELOPE_SOURCES)[number];

export interface ProtocolCapabilities {
  envelope: boolean;
  inspectV2: boolean;
  deviceTrust: boolean;
}

export interface RemuxEnvelope<TPayload = unknown> {
  domain: RemuxDomain;
  type: string;
  version: typeof REMUX_PROTOCOL_VERSION;
  requestId?: string;
  emittedAt: string;
  source: EnvelopeSource;
  payload: TPayload;
}

export interface CreateEnvelopeOptions {
  requestId?: string;
  emittedAt?: string;
  source?: EnvelopeSource;
}

export interface ParseEnvelopeOptions {
  allowLegacyFallback?: boolean;
  source?: EnvelopeSource;
}

export const EMPTY_PROTOCOL_CAPABILITIES: ProtocolCapabilities = {
  envelope: false,
  inspectV2: false,
  deviceTrust: false,
};

export const SERVER_PROTOCOL_CAPABILITIES: ProtocolCapabilities = {
  envelope: true,
  inspectV2: true,
  deviceTrust: false,
};

export const createEnvelope = <TPayload>(
  domain: RemuxDomain,
  type: string,
  payload: TPayload,
  options: CreateEnvelopeOptions = {},
): RemuxEnvelope<TPayload> => {
  return {
    domain,
    type,
    version: REMUX_PROTOCOL_VERSION,
    ...(options.requestId ? { requestId: options.requestId } : {}),
    emittedAt: options.emittedAt ?? new Date().toISOString(),
    source: options.source ?? "server",
    payload,
  };
};

export const normalizeProtocolCapabilities = (value: unknown): ProtocolCapabilities => {
  if (!value || typeof value !== "object") {
    return { ...EMPTY_PROTOCOL_CAPABILITIES };
  }

  const candidate = value as Partial<Record<keyof ProtocolCapabilities, unknown>>;
  return {
    envelope: candidate.envelope === true,
    inspectV2: candidate.inspectV2 === true,
    deviceTrust: candidate.deviceTrust === true,
  };
};

export const isEnvelope = (value: unknown): value is RemuxEnvelope<unknown> => {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<RemuxEnvelope<unknown>>;
  return REMUX_DOMAINS.includes(candidate.domain as RemuxDomain)
    && typeof candidate.type === "string"
    && candidate.version === REMUX_PROTOCOL_VERSION
    && typeof candidate.emittedAt === "string"
    && ENVELOPE_SOURCES.includes(candidate.source as EnvelopeSource)
    && "payload" in candidate;
};

export const parseEnvelope = <TPayload = Record<string, unknown>>(
  raw: unknown,
  options: ParseEnvelopeOptions = {},
): RemuxEnvelope<TPayload> | null => {
  const allowLegacyFallback = options.allowLegacyFallback ?? true;
  const parsed = parseJsonIfNeeded(raw);
  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  if (isEnvelope(parsed)) {
    return parsed as RemuxEnvelope<TPayload>;
  }

  if (!allowLegacyFallback) {
    return null;
  }

  const legacyMessage = parsed as Record<string, unknown>;
  if (typeof legacyMessage.type !== "string") {
    return null;
  }

  const { type, ...payload } = legacyMessage;
  return createEnvelope("core", type, payload as TPayload, {
    source: options.source ?? "server",
  });
};

const parseJsonIfNeeded = (raw: unknown): unknown => {
  if (typeof raw !== "string") {
    return raw;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};
