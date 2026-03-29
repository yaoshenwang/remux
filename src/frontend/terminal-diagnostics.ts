import type {
  ClientDiagnosticAction,
  ClientDiagnosticDetails,
  ClientDiagnosticIssue,
  ClientDiagnosticSample,
  ClientDiagnosticSeverity,
  ClientDiagnosticStatus,
} from "../shared/protocol.js";

export type TerminalDiagnosticAction = ClientDiagnosticAction;

export interface TerminalDiagnosticRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface TerminalDiagnosticGeometry {
  cols: number;
  rows: number;
}

export interface TerminalDiagnosticSample {
  sampledAt: string;
  theme: "dark" | "light";
  viewMode: "inspect" | "terminal";
  terminalViewState: "idle" | "connecting" | "restoring" | "live" | "stale";
  viewRevision?: number;
  terminalEpoch?: number;
  appRect: TerminalDiagnosticRect;
  hostRect: TerminalDiagnosticRect;
  screenRect: TerminalDiagnosticRect | null;
  viewportRect: TerminalDiagnosticRect | null;
  frontendGeometry: TerminalDiagnosticGeometry | null;
  backendGeometry: TerminalDiagnosticGeometry | null;
  backgroundColor: string | null;
  foregroundColor: string | null;
  terminalBackgroundColor: string | null;
  terminalForegroundColor: string | null;
  contrastRatio: number | null;
  bufferLineCount: number;
  bufferTail: string[];
  lastResizeSource: string;
}

export interface TerminalRedlineFinding {
  kind: ClientDiagnosticIssue;
  severity: ClientDiagnosticSeverity;
  summary: string;
  evidence: Record<string, number | string | boolean | null>;
  recentActions: TerminalDiagnosticAction[];
  sample: ClientDiagnosticSample;
}

interface DetectTerminalRedlinesOptions {
  current: TerminalDiagnosticSample;
  previous?: TerminalDiagnosticSample;
  recentActions: TerminalDiagnosticAction[];
  protectedBufferMarkers: string[];
  historyGapSuppressed: boolean;
}

const MIN_REASONABLE_CELL_WIDTH_PX = 4;
const MAX_REASONABLE_CELL_WIDTH_PX = 14;
const MIN_REASONABLE_CELL_HEIGHT_PX = 8;
const MAX_REASONABLE_CELL_HEIGHT_PX = 24;
const MAX_LAYOUT_OFFSET_PX = 24;
const MIN_LAYOUT_WIDTH_RATIO = 0.72;
const MIN_LAYOUT_HEIGHT_RATIO = 0.72;
const HISTORY_GAP_MIN_PREVIOUS_LINES = 60;
const HISTORY_GAP_MAX_REMAINING_RATIO = 0.55;
const WHITEOUT_CONTRAST_RATIO = 1.25;

export const TERMINAL_REDLINE_LABELS: Record<ClientDiagnosticIssue, string> = {
  layout_misalignment: "layout misalignment",
  color_whiteout: "color whiteout",
  width_mismatch: "width drift",
  history_gap: "history gap",
};

const normalizeColor = (value: string | null | undefined): string | null => {
  if (!value) {
    return null;
  }
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
};

const parseColor = (value: string | null | undefined): [number, number, number] | null => {
  const normalized = normalizeColor(value);
  if (!normalized) {
    return null;
  }

  const hexMatch = normalized.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hexMatch) {
    const hex = hexMatch[1]!.length === 3
      ? hexMatch[1]!.split("").map((part) => `${part}${part}`).join("")
      : hexMatch[1]!;
    return [
      Number.parseInt(hex.slice(0, 2), 16),
      Number.parseInt(hex.slice(2, 4), 16),
      Number.parseInt(hex.slice(4, 6), 16),
    ];
  }

  const rgbMatch = normalized.match(/^rgba?\(([^)]+)\)$/);
  if (!rgbMatch) {
    return null;
  }

  const channels = rgbMatch[1]!
    .split(",")
    .slice(0, 3)
    .map((part) => Number.parseFloat(part.trim()));

  if (channels.length !== 3 || channels.some((channel) => Number.isNaN(channel))) {
    return null;
  }

  return channels.map((channel) => Math.max(0, Math.min(255, channel))) as [number, number, number];
};

const channelToLinear = (channel: number): number => {
  const normalized = channel / 255;
  return normalized <= 0.03928
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
};

const luminance = (color: [number, number, number]): number => (
  (0.2126 * channelToLinear(color[0]))
  + (0.7152 * channelToLinear(color[1]))
  + (0.0722 * channelToLinear(color[2]))
);

export const computeContrastRatio = (
  backgroundColor: string | null | undefined,
  foregroundColor: string | null | undefined
): number | null => {
  const background = parseColor(backgroundColor);
  const foreground = parseColor(foregroundColor);
  if (!background || !foreground) {
    return null;
  }

  const lighter = Math.max(luminance(background), luminance(foreground));
  const darker = Math.min(luminance(background), luminance(foreground));
  return Number((((lighter + 0.05) / (darker + 0.05))).toFixed(2));
};

const roundMetric = (value: number): number => Number(value.toFixed(2));

const sanitizeBufferLines = (lines: string[]): string[] => lines
  .map((line) => line.trim())
  .filter((line) => line.length > 0);

const pushFinding = (
  findings: TerminalRedlineFinding[],
  kind: ClientDiagnosticIssue,
  severity: ClientDiagnosticSeverity,
  summary: string,
  current: TerminalDiagnosticSample,
  recentActions: TerminalDiagnosticAction[],
  evidence: Record<string, number | string | boolean | null>,
): void => {
  findings.push({
    kind,
    severity,
    summary,
    evidence,
    recentActions,
    sample: flattenTerminalDiagnosticSample(current),
  });
};

export const flattenTerminalDiagnosticSample = (
  sample: TerminalDiagnosticSample
): ClientDiagnosticSample => ({
  theme: sample.theme,
  viewMode: sample.viewMode,
  terminalViewState: sample.terminalViewState,
  viewRevision: sample.viewRevision,
  terminalEpoch: sample.terminalEpoch,
  frontendCols: sample.frontendGeometry?.cols,
  frontendRows: sample.frontendGeometry?.rows,
  backendCols: sample.backendGeometry?.cols,
  backendRows: sample.backendGeometry?.rows,
  hostWidth: roundMetric(sample.hostRect.width),
  hostHeight: roundMetric(sample.hostRect.height),
  screenWidth: sample.screenRect ? roundMetric(sample.screenRect.width) : undefined,
  screenOffsetLeft: sample.screenRect ? roundMetric(sample.screenRect.left - sample.hostRect.left) : undefined,
  screenOffsetTop: sample.screenRect ? roundMetric(sample.screenRect.top - sample.hostRect.top) : undefined,
  viewportWidth: sample.viewportRect ? roundMetric(sample.viewportRect.width) : undefined,
  viewportOffsetLeft: sample.viewportRect ? roundMetric(sample.viewportRect.left - sample.hostRect.left) : undefined,
  contrastRatio: sample.contrastRatio ?? undefined,
  bufferLineCount: sample.bufferLineCount,
  lastResizeSource: sample.lastResizeSource,
});

export const summarizeTerminalBuffer = (
  rawBuffer: string,
  tailLines: number = 8
): { lineCount: number; tail: string[] } => {
  const sanitized = rawBuffer
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "");
  const lines = sanitizeBufferLines(sanitized.split("\n"));
  return {
    lineCount: lines.length,
    tail: lines.slice(-tailLines),
  };
};

export const selectProtectedBufferMarkers = (
  tail: string[],
  limit: number = 4
): string[] => {
  const unique = Array.from(new Set(sanitizeBufferLines(tail)));
  return unique.slice(-limit);
};

export const detectTerminalRedlines = ({
  current,
  previous,
  recentActions,
  protectedBufferMarkers,
  historyGapSuppressed
}: DetectTerminalRedlinesOptions): TerminalRedlineFinding[] => {
  const findings: TerminalRedlineFinding[] = [];

  const frontendCols = current.frontendGeometry?.cols ?? 0;
  const frontendRows = current.frontendGeometry?.rows ?? 0;
  const backendCols = current.backendGeometry?.cols ?? 0;
  const backendRows = current.backendGeometry?.rows ?? 0;
  const pxPerCol = frontendCols > 0 ? current.hostRect.width / frontendCols : 0;
  const pxPerRow = frontendRows > 0 ? current.hostRect.height / frontendRows : 0;
  const viewportWidthRatio = current.viewportRect && current.hostRect.width > 0
    ? current.viewportRect.width / current.hostRect.width
    : 1;

  if (
    frontendCols > 1
    && frontendRows > 1
    && (
      (backendCols > 0 && Math.abs(backendCols - frontendCols) > 3)
      || (backendRows > 0 && Math.abs(backendRows - frontendRows) > 3)
      || pxPerCol < MIN_REASONABLE_CELL_WIDTH_PX
      || pxPerCol > MAX_REASONABLE_CELL_WIDTH_PX
      || pxPerRow < MIN_REASONABLE_CELL_HEIGHT_PX
      || pxPerRow > MAX_REASONABLE_CELL_HEIGHT_PX
      || viewportWidthRatio < MIN_LAYOUT_WIDTH_RATIO
    )
  ) {
    pushFinding(
      findings,
      "width_mismatch",
      "error",
      "Terminal width drifted away from the visible container.",
      current,
      recentActions,
      {
        frontendCols,
        frontendRows,
        backendCols,
        backendRows,
        hostWidth: roundMetric(current.hostRect.width),
        hostHeight: roundMetric(current.hostRect.height),
        pxPerCol: roundMetric(pxPerCol),
        pxPerRow: roundMetric(pxPerRow),
        viewportWidthRatio: roundMetric(viewportWidthRatio),
      }
    );
  }

  if (current.screenRect) {
    const screenOffsetLeft = Math.abs(current.screenRect.left - current.hostRect.left);
    const screenOffsetTop = Math.abs(current.screenRect.top - current.hostRect.top);
    const screenWidthRatio = current.hostRect.width > 0
      ? current.screenRect.width / current.hostRect.width
      : 1;
    const screenHeightRatio = current.hostRect.height > 0
      ? current.screenRect.height / current.hostRect.height
      : 1;

    if (
      screenOffsetLeft > MAX_LAYOUT_OFFSET_PX
      || screenOffsetTop > MAX_LAYOUT_OFFSET_PX
      || screenWidthRatio < MIN_LAYOUT_WIDTH_RATIO
      || screenHeightRatio < MIN_LAYOUT_HEIGHT_RATIO
    ) {
      pushFinding(
        findings,
        "layout_misalignment",
        "error",
        "The rendered xterm surface is offset from the terminal host.",
        current,
        recentActions,
        {
          screenOffsetLeft: roundMetric(screenOffsetLeft),
          screenOffsetTop: roundMetric(screenOffsetTop),
          screenWidthRatio: roundMetric(screenWidthRatio),
          screenHeightRatio: roundMetric(screenHeightRatio),
        }
      );
    }
  }

  const contrastRatio = current.contrastRatio
    ?? computeContrastRatio(current.terminalBackgroundColor ?? current.backgroundColor, current.terminalForegroundColor ?? current.foregroundColor);
  if (contrastRatio !== null && contrastRatio < WHITEOUT_CONTRAST_RATIO) {
    pushFinding(
      findings,
      "color_whiteout",
      "error",
      "Terminal colors collapsed into a near-whiteout, low-contrast state.",
      current,
      recentActions,
      {
        contrastRatio,
        backgroundColor: normalizeColor(current.backgroundColor),
        foregroundColor: normalizeColor(current.foregroundColor),
        terminalBackgroundColor: normalizeColor(current.terminalBackgroundColor),
        terminalForegroundColor: normalizeColor(current.terminalForegroundColor),
      }
    );
  }

  if (
    !historyGapSuppressed
    && current.terminalViewState === "live"
    && previous
    && previous.bufferLineCount >= HISTORY_GAP_MIN_PREVIOUS_LINES
  ) {
    const remainingRatio = previous.bufferLineCount > 0
      ? current.bufferLineCount / previous.bufferLineCount
      : 1;
    const currentTailText = current.bufferTail.join("\n");
    const missingMarkers = sanitizeBufferLines(protectedBufferMarkers)
      .filter((marker) => !currentTailText.includes(marker));

    if (
      remainingRatio <= HISTORY_GAP_MAX_REMAINING_RATIO
      && missingMarkers.length >= Math.min(2, sanitizeBufferLines(protectedBufferMarkers).length)
    ) {
      pushFinding(
        findings,
        "history_gap",
        "error",
        "Recent terminal history disappeared from the client buffer.",
        current,
        recentActions,
        {
          previousLineCount: previous.bufferLineCount,
          currentLineCount: current.bufferLineCount,
          remainingRatio: roundMetric(remainingRatio),
          missingMarkers: missingMarkers.join(" | "),
        }
      );
    }
  }

  return findings;
};

export const buildDiagnosticDetails = (
  finding: TerminalRedlineFinding,
  status: ClientDiagnosticStatus,
  recentSamples: ClientDiagnosticSample[] = []
): ClientDiagnosticDetails => ({
  issue: finding.kind,
  severity: finding.severity,
  status,
  summary: finding.summary,
  sample: finding.sample,
  recentActions: finding.recentActions,
  recentSamples,
});

export const buildDiagnosticEventText = (
  issue: ClientDiagnosticIssue,
  summary: string,
  status: ClientDiagnosticStatus
): string => {
  const prefix = status === "resolved" ? "Redline resolved" : "Redline opened";
  return `${prefix}: ${TERMINAL_REDLINE_LABELS[issue]} - ${summary}`;
};

export const summarizeActiveRedlines = (findings: Array<{ kind: ClientDiagnosticIssue }>): string => {
  if (findings.length === 0) {
    return "";
  }
  if (findings.length === 1) {
    return TERMINAL_REDLINE_LABELS[findings[0]!.kind];
  }
  return findings.map((finding) => TERMINAL_REDLINE_LABELS[finding.kind]).join(" · ");
};
