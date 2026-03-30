export const INSPECT_SCOPES = ["pane", "tab", "session"] as const;
export const INSPECT_SOURCES = ["runtime_capture", "state_tracker", "local_cache"] as const;
export const INSPECT_PRECISIONS = ["precise", "approximate", "partial"] as const;
export const INSPECT_STALENESS_VALUES = ["fresh", "stale", "unknown"] as const;

export type InspectScope = (typeof INSPECT_SCOPES)[number];
export type InspectSource = (typeof INSPECT_SOURCES)[number];
export type InspectPrecision = (typeof INSPECT_PRECISIONS)[number];
export type InspectStaleness = (typeof INSPECT_STALENESS_VALUES)[number];
export type InspectItemType = "output" | "event" | "marker";

export interface InspectHighlight {
  start: number;
  end: number;
}

export interface InspectDescriptor {
  scope: InspectScope;
  source: InspectSource;
  precision: InspectPrecision;
  staleness: InspectStaleness;
  capturedAt: string;
  paneId?: string;
  tabIndex?: number;
  totalItems?: number;
}

export interface InspectItem {
  type: InspectItemType;
  content: string;
  lineNumber: number | null;
  timestamp: string;
  paneId?: string;
  highlights?: InspectHighlight[];
}

export interface InspectSnapshot {
  descriptor: InspectDescriptor;
  items: InspectItem[];
  cursor: string | null;
  truncated: boolean;
}

export interface InspectQueryOptions {
  cursor?: string | null;
  query?: string;
  limit?: number;
}

export interface InspectRequest {
  scope: "pane" | "tab";
  paneId?: string;
  tabIndex?: number;
  cursor?: string | null;
  query?: string;
  limit?: number;
}
