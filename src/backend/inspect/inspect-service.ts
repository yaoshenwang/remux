import type { TerminalStateTracker } from "../terminal-state/index.js";
import type { WorkspacePane, WorkspaceState, ZellijControllerApi } from "../zellij-controller.js";
import type {
  InspectDescriptor,
  InspectHighlight,
  InspectItem,
  InspectQueryOptions,
  InspectSnapshot,
  InspectSource,
} from "./types.js";

const CURSOR_VERSION = 1;
export const DEFAULT_INSPECT_LIMIT = 100;
export const MAX_INSPECT_LIMIT = 1000;

type TrackerSource = TerminalStateTracker | null | (() => TerminalStateTracker | null);
type InspectController = Pick<ZellijControllerApi, "queryWorkspaceState" | "dumpPaneScreen">;

interface InspectCursorPayload {
  version: number;
  scope: "pane" | "tab";
  paneId?: string;
  tabIndex?: number;
  offset: number;
  query?: string;
}

interface PreparedInspectLine {
  content: string;
  lineNumber: number;
  highlights?: InspectHighlight[];
}

export interface InspectServiceOptions {
  tracker?: TrackerSource;
  controller?: InspectController;
  now?: () => Date;
}

export class InspectBadRequestError extends Error {
  readonly statusCode = 400;
}

export class InvalidInspectCursorError extends InspectBadRequestError {}

export class InspectService {
  private readonly tracker: TrackerSource;
  private readonly controller: InspectController | undefined;
  private readonly now: () => Date;

  constructor(options: InspectServiceOptions = {}) {
    this.tracker = options.tracker ?? null;
    this.controller = options.controller;
    this.now = options.now ?? (() => new Date());
  }

  async queryPaneHistory(
    paneId: string,
    options: InspectQueryOptions = {},
  ): Promise<InspectSnapshot> {
    const { limit, offset, query } = this.resolveQueryOptions(
      { scope: "pane", paneId },
      options,
    );
    const capturedAt = this.now().toISOString();
    const { lines, source } = await this.capturePaneLines(paneId);
    const filteredLines = filterInspectLines(lines, query);

    return buildSnapshot({
      descriptor: {
        scope: "pane",
        source,
        precision: "precise",
        staleness: "fresh",
        capturedAt,
        paneId,
        totalItems: filteredLines.length,
      },
      items: paginateInspectItems(
        filteredLines.map((line) => toOutputItem(line, paneId, capturedAt)),
        offset,
        limit,
      ),
      offset,
      limit,
      query,
    });
  }

  async queryTabHistory(
    tabIndex: number,
    options: InspectQueryOptions = {},
  ): Promise<InspectSnapshot> {
    const { limit, offset, query } = this.resolveQueryOptions(
      { scope: "tab", tabIndex },
      options,
    );
    const capturedAt = this.now().toISOString();
    const workspace = await this.controller?.queryWorkspaceState();
    const tab = workspace?.tabs.find((candidate) => candidate.index === tabIndex);

    if (!workspace || !tab) {
    return buildSnapshot({
      descriptor: {
        scope: "tab",
        source: this.controller ? "runtime_capture" : "state_tracker",
          precision: "partial",
          staleness: "fresh",
          capturedAt,
          tabIndex,
          totalItems: 0,
      },
      items: [],
      offset,
      limit,
      query,
    });
    }

    const source = this.controller ? "runtime_capture" : "state_tracker";
    const items: InspectItem[] = [];
    for (const pane of tab.panes) {
      const paneLines = await this.captureTabPaneLines(workspace, pane, query, capturedAt);
      if (paneLines.length === 0) {
        continue;
      }
      items.push({
        type: "marker",
        content: `Pane ${pane.id}`,
        lineNumber: null,
        timestamp: capturedAt,
        paneId: pane.id,
      });
      items.push(...paneLines);
    }

    return buildSnapshot({
      descriptor: {
        scope: "tab",
        source,
        precision: "partial",
        staleness: "fresh",
        capturedAt,
        tabIndex,
        totalItems: items.length,
      },
      items: paginateInspectItems(items, offset, limit),
      offset,
      limit,
      query,
    });
  }

  private resolveQueryOptions(
    expectedScope: { scope: "pane"; paneId: string } | { scope: "tab"; tabIndex: number },
    options: InspectQueryOptions,
  ): { limit: number; offset: number; query?: string } {
    const limit = normalizeInspectLimit(options.limit);
    const normalizedQuery = normalizeInspectQuery(options.query);
    if (!options.cursor) {
      return {
        limit,
        offset: 0,
        query: normalizedQuery,
      };
    }

    const cursor = decodeInspectCursor(options.cursor);
    if (cursor.scope !== expectedScope.scope) {
      throw new InvalidInspectCursorError("invalid inspect cursor");
    }
    if (cursor.scope === "pane") {
      if (expectedScope.scope !== "pane" || cursor.paneId !== expectedScope.paneId) {
        throw new InvalidInspectCursorError("invalid inspect cursor");
      }
    }
    if (cursor.scope === "tab") {
      if (expectedScope.scope !== "tab" || cursor.tabIndex !== expectedScope.tabIndex) {
        throw new InvalidInspectCursorError("invalid inspect cursor");
      }
    }
    if ((cursor.query ?? undefined) !== normalizedQuery) {
      throw new InvalidInspectCursorError("invalid inspect cursor");
    }

    return {
      limit,
      offset: cursor.offset,
      query: normalizedQuery,
    };
  }

  private async capturePaneLines(
    paneId: string,
  ): Promise<{ lines: string[]; source: InspectSource }> {
    if (this.controller) {
      const content = await this.controller.dumpPaneScreen(paneId, true);
      return {
        lines: splitInspectLines(content),
        source: "runtime_capture",
      };
    }

    const tracker = this.readTracker();
    if (!tracker) {
      return {
        lines: [],
        source: "state_tracker",
      };
    }

    return {
      lines: tracker.getInspectLines(0, tracker.totalLines),
      source: "state_tracker",
    };
  }

  private async captureTabPaneLines(
    workspace: WorkspaceState,
    pane: WorkspacePane,
    query: string | undefined,
    capturedAt: string,
  ): Promise<InspectItem[]> {
    const lines = this.controller
      ? splitInspectLines(await this.controller.dumpPaneScreen(pane.id, true))
      : this.readTracker()?.getInspectLines(0, this.readTracker()?.totalLines ?? 0) ?? [];

    return filterInspectLines(lines, query).map((line) => toOutputItem(line, pane.id, capturedAt));
  }

  private readTracker(): TerminalStateTracker | null {
    return typeof this.tracker === "function" ? this.tracker() : this.tracker;
  }
}

const normalizeInspectLimit = (limit?: number): number => {
  if (!Number.isFinite(limit)) {
    return DEFAULT_INSPECT_LIMIT;
  }
  return Math.max(1, Math.min(MAX_INSPECT_LIMIT, Math.trunc(limit ?? DEFAULT_INSPECT_LIMIT)));
};

const normalizeInspectQuery = (query?: string): string | undefined => {
  const trimmed = query?.trim();
  return trimmed ? trimmed : undefined;
};

const splitInspectLines = (content: string): string[] => {
  if (content.length === 0) {
    return [];
  }
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
};

const filterInspectLines = (
  lines: string[],
  query?: string,
): PreparedInspectLine[] => {
  if (!query) {
    return lines.map((content, index) => ({
      content,
      lineNumber: index + 1,
    }));
  }

  const normalizedNeedle = query.toLocaleLowerCase();
  const includedIndices = new Set<number>();

  lines.forEach((content, index) => {
    if (!content.toLocaleLowerCase().includes(normalizedNeedle)) {
      return;
    }
    for (let cursor = Math.max(0, index - 2); cursor <= Math.min(lines.length - 1, index + 2); cursor += 1) {
      includedIndices.add(cursor);
    }
  });

  return Array.from(includedIndices)
    .sort((left, right) => left - right)
    .map((index) => ({
      content: lines[index] ?? "",
      lineNumber: index + 1,
      highlights: collectHighlights(lines[index] ?? "", normalizedNeedle),
    }));
};

const collectHighlights = (
  content: string,
  normalizedNeedle: string,
): InspectHighlight[] | undefined => {
  if (!normalizedNeedle) {
    return undefined;
  }

  const normalizedContent = content.toLocaleLowerCase();
  const highlights: InspectHighlight[] = [];
  let cursor = normalizedContent.indexOf(normalizedNeedle);
  while (cursor !== -1) {
    highlights.push({
      start: cursor,
      end: cursor + normalizedNeedle.length,
    });
    cursor = normalizedContent.indexOf(normalizedNeedle, cursor + normalizedNeedle.length);
  }

  return highlights.length > 0 ? highlights : undefined;
};

const toOutputItem = (
  line: PreparedInspectLine,
  paneId: string,
  capturedAt: string,
): InspectItem => ({
  type: "output",
  content: line.content,
  lineNumber: line.lineNumber,
  timestamp: capturedAt,
  paneId,
  highlights: line.highlights,
});

const paginateInspectItems = (
  items: InspectItem[],
  offset: number,
  limit: number,
): InspectItem[] => items.slice(offset, offset + limit);

const buildSnapshot = ({
  descriptor,
  items,
  offset,
  limit,
  query,
}: {
  descriptor: InspectDescriptor;
  items: InspectItem[];
  offset: number;
  limit: number;
  query?: string;
}): InspectSnapshot => {
  const totalItems = descriptor.totalItems ?? items.length;
  const nextOffset = offset + items.length;

  return {
    descriptor,
    items,
    cursor: nextOffset < totalItems
      ? encodeInspectCursor({
        version: CURSOR_VERSION,
        scope: descriptor.scope === "tab" ? "tab" : "pane",
        paneId: descriptor.paneId,
        tabIndex: descriptor.tabIndex,
        offset: nextOffset,
        query,
      })
      : null,
    truncated: nextOffset < totalItems && totalItems > limit,
  };
};

export const encodeInspectCursor = (payload: InspectCursorPayload): string =>
  Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");

export const decodeInspectCursor = (cursor: string): InspectCursorPayload => {
  try {
    const payload = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as InspectCursorPayload;
    if (
      payload.version !== CURSOR_VERSION ||
      (payload.scope !== "pane" && payload.scope !== "tab") ||
      !Number.isInteger(payload.offset) ||
      payload.offset < 0
    ) {
      throw new Error("invalid inspect cursor");
    }
    return payload;
  } catch {
    throw new InvalidInspectCursorError("invalid inspect cursor");
  }
};
