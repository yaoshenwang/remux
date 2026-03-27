import type {
  RuntimeV2ControlClientMessage,
  RuntimeV2ControlServerMessage,
  RuntimeV2SplitDirection,
  RuntimeV2TerminalClientMessage,
  RuntimeV2TerminalServerMessage,
} from "./types.js";

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const camelizeKey = (key: string): string =>
  key.includes("_")
    ? key.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase())
    : key;

const snakeifyKey = (key: string): string =>
  key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

const normalizeIncomingValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeIncomingValue(entry));
  }
  if (!isObject(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      camelizeKey(key),
      normalizeIncomingValue(entry),
    ]),
  );
};

const normalizeOutgoingDirection = (value: RuntimeV2SplitDirection): string => {
  if (value === "right") {
    return "vertical";
  }
  if (value === "down") {
    return "horizontal";
  }
  return value;
};

const normalizeOutgoingValue = (value: unknown, key?: string): unknown => {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeOutgoingValue(entry));
  }
  if (key === "direction" && typeof value === "string") {
    return normalizeOutgoingDirection(value as RuntimeV2SplitDirection);
  }
  if (!isObject(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([entryKey, entryValue]) => [
      snakeifyKey(entryKey),
      normalizeOutgoingValue(entryValue, entryKey),
    ]),
  );
};

const parseRuntimeV2Message = <T>(raw: string): T => (
  normalizeIncomingValue(JSON.parse(raw)) as T
);

export const parseRuntimeV2ControlMessage = (
  raw: string,
): RuntimeV2ControlServerMessage => parseRuntimeV2Message<RuntimeV2ControlServerMessage>(raw);

export const parseRuntimeV2TerminalMessage = (
  raw: string,
): RuntimeV2TerminalServerMessage => parseRuntimeV2Message<RuntimeV2TerminalServerMessage>(raw);

export const serializeRuntimeV2ControlMessage = (
  message: RuntimeV2ControlClientMessage,
): string => JSON.stringify(normalizeOutgoingValue(message));

export const serializeRuntimeV2TerminalMessage = (
  message: RuntimeV2TerminalClientMessage,
): string => JSON.stringify(normalizeOutgoingValue(message));
