import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject, type RefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import type { ClientDiagnosticDetails, ClientDiagnosticIssue, ClientDiagnosticStatus } from "../../shared/protocol.js";
import { debugLog } from "../remux-runtime.js";
import {
  buildDiagnosticDetails,
  computeContrastRatio,
  detectTerminalRedlines,
  flattenTerminalDiagnosticSample,
  selectProtectedBufferMarkers,
  summarizeActiveRedlines,
  summarizeTerminalBuffer,
  type TerminalDiagnosticAction,
  type TerminalDiagnosticSample,
  type TerminalRedlineFinding,
} from "../terminal-diagnostics.js";

const DIAGNOSTIC_STORAGE_KEY = "remux-terminal-diagnostics-v1";
const MAX_STORED_ACTIONS = 40;
const MAX_STORED_INCIDENTS = 80;
const MAX_RECENT_SAMPLES = 6;
const SAMPLE_INTERVAL_MS = 500;
const HISTORY_GAP_SUPPRESSION_MS = 2_500;

export interface RuntimeTerminalRedlineIncident {
  id: string;
  at: string;
  kind: ClientDiagnosticIssue;
  severity: "warn" | "error";
  status: ClientDiagnosticStatus;
  summary: string;
  diagnostic: ClientDiagnosticDetails;
}

interface PersistedDiagnosticsState {
  incidents: RuntimeTerminalRedlineIncident[];
  recentActions: TerminalDiagnosticAction[];
}

interface UseTerminalDiagnosticsOptions {
  activePaneId: string | null;
  activeTabIndex: number | null;
  activeTabName: string;
  attachedSession: string;
  lastReportedGeometry: { cols: number; rows: number; source: string } | null;
  readTerminalBuffer: () => string;
  readTerminalGeometry: () => { cols: number; rows: number } | null;
  reportDiagnostic: (payload: {
    session?: string;
    tabIndex?: number;
    paneId?: string;
    diagnostic: ClientDiagnosticDetails;
  }) => void;
  terminalEpoch: number | null;
  terminalContainerRef: RefObject<HTMLDivElement | null>;
  terminalRef: MutableRefObject<Terminal | null>;
  terminalViewState: "idle" | "connecting" | "restoring" | "live" | "stale";
  theme: "dark" | "light";
  viewRevision: number | null;
  viewMode: "inspect" | "terminal";
}

interface UseTerminalDiagnosticsResult {
  activeIssues: RuntimeTerminalRedlineIncident[];
  activeRedlineCount: number;
  activeRedlineSummary: string;
  recordAction: (type: string, label: string, detail?: string) => void;
  suppressHistoryGap: (reason: string) => void;
}

declare global {
  interface Window {
    __remuxDiagnostics?: {
      readState: () => {
        activeIssues: RuntimeTerminalRedlineIncident[];
        incidentLog: RuntimeTerminalRedlineIncident[];
        recentActions: TerminalDiagnosticAction[];
      };
    };
  }
}

const readPersistedState = (): PersistedDiagnosticsState => {
  try {
    const raw = localStorage.getItem(DIAGNOSTIC_STORAGE_KEY);
    if (!raw) {
      return { incidents: [], recentActions: [] };
    }
    const parsed = JSON.parse(raw) as Partial<PersistedDiagnosticsState>;
    return {
      incidents: Array.isArray(parsed.incidents) ? parsed.incidents.slice(-MAX_STORED_INCIDENTS) as RuntimeTerminalRedlineIncident[] : [],
      recentActions: Array.isArray(parsed.recentActions) ? parsed.recentActions.slice(-MAX_STORED_ACTIONS) as TerminalDiagnosticAction[] : [],
    };
  } catch {
    return { incidents: [], recentActions: [] };
  }
};

const trimActions = (actions: TerminalDiagnosticAction[]): TerminalDiagnosticAction[] =>
  actions.slice(-MAX_STORED_ACTIONS);

const trimIncidents = (incidents: RuntimeTerminalRedlineIncident[]): RuntimeTerminalRedlineIncident[] =>
  incidents.slice(-MAX_STORED_INCIDENTS);

const buildZeroRect = (): TerminalDiagnosticSample["hostRect"] => ({
  left: 0,
  top: 0,
  width: 0,
  height: 0,
});

const describeActionTarget = (target: EventTarget | null): string | null => {
  if (!(target instanceof Element)) {
    return null;
  }
  const element = target.closest("[data-testid],button,input,textarea,[role='button'],[title],[aria-label]") as HTMLElement | null;
  if (!element) {
    return null;
  }

  const label = (
    element.getAttribute("aria-label")
    ?? element.getAttribute("title")
    ?? element.getAttribute("data-testid")
    ?? element.textContent
    ?? element.tagName.toLowerCase()
  ).replace(/\s+/g, " ").trim();

  return label.length > 0 ? label.slice(0, 120) : null;
};

export const useTerminalDiagnostics = ({
  activePaneId,
  activeTabIndex,
  activeTabName,
  attachedSession,
  lastReportedGeometry,
  readTerminalBuffer,
  readTerminalGeometry,
  reportDiagnostic,
  terminalEpoch,
  terminalContainerRef,
  terminalRef,
  terminalViewState,
  theme,
  viewRevision,
  viewMode,
}: UseTerminalDiagnosticsOptions): UseTerminalDiagnosticsResult => {
  const persistedState = useMemo(readPersistedState, []);
  const [activeIssues, setActiveIssues] = useState<RuntimeTerminalRedlineIncident[]>([]);
  const [incidentLog, setIncidentLog] = useState<RuntimeTerminalRedlineIncident[]>(persistedState.incidents);
  const recentActionsRef = useRef<TerminalDiagnosticAction[]>(persistedState.recentActions);
  const recentSamplesRef = useRef<ReturnType<typeof flattenTerminalDiagnosticSample>[]>([]);
  const previousSampleRef = useRef<TerminalDiagnosticSample | undefined>(undefined);
  const protectedBufferMarkersRef = useRef<string[]>([]);
  const historyGapSuppressedUntilRef = useRef(0);
  const contextKeyRef = useRef<string | null>(null);
  const activeFindingMapRef = useRef<Map<ClientDiagnosticIssue, { finding: TerminalRedlineFinding; id: string; openedAt: string }>>(new Map());
  const incidentLogRef = useRef<RuntimeTerminalRedlineIncident[]>(persistedState.incidents);

  const persistState = useCallback(() => {
    localStorage.setItem(
      DIAGNOSTIC_STORAGE_KEY,
      JSON.stringify({
        incidents: trimIncidents(incidentLogRef.current),
        recentActions: trimActions(recentActionsRef.current),
      } satisfies PersistedDiagnosticsState)
    );
  }, []);

  const recordAction = useCallback((type: string, label: string, detail?: string): void => {
    const nextAction = {
      at: new Date().toISOString(),
      type,
      label,
      detail,
    } satisfies TerminalDiagnosticAction;
    recentActionsRef.current = trimActions([...recentActionsRef.current, nextAction]);
    persistState();
  }, [persistState]);

  const suppressHistoryGap = useCallback((reason: string): void => {
    historyGapSuppressedUntilRef.current = Date.now() + HISTORY_GAP_SUPPRESSION_MS;
    recordAction("runtime.suppress_history_gap", `Suppress history gap: ${reason}`);
  }, [recordAction]);

  const collectSample = useCallback((): TerminalDiagnosticSample | null => {
    const container = terminalContainerRef.current;
    const appShell = document.querySelector(".app-shell") as HTMLElement | null;
    const screen = container?.querySelector(".xterm-screen") as HTMLElement | null;
    const viewport = container?.querySelector(".xterm-viewport") as HTMLElement | null;
    const hostStyle = container ? window.getComputedStyle(container) : null;
    const appStyle = appShell ? window.getComputedStyle(appShell) : null;
    const terminalTheme = terminalRef.current?.options.theme;
    const geometry = readTerminalGeometry();
    const bufferSummary = summarizeTerminalBuffer(readTerminalBuffer());
    const contrastRatio = computeContrastRatio(
      terminalTheme?.background ?? hostStyle?.backgroundColor ?? appStyle?.backgroundColor,
      terminalTheme?.foreground ?? hostStyle?.color ?? appStyle?.color,
    );

    return {
      sampledAt: new Date().toISOString(),
      theme,
      viewMode,
      terminalViewState,
      viewRevision: viewRevision ?? undefined,
      terminalEpoch: terminalEpoch ?? undefined,
      appRect: appShell ? appShell.getBoundingClientRect().toJSON() : buildZeroRect(),
      hostRect: container ? container.getBoundingClientRect().toJSON() : buildZeroRect(),
      screenRect: screen ? screen.getBoundingClientRect().toJSON() : null,
      viewportRect: viewport ? viewport.getBoundingClientRect().toJSON() : null,
      frontendGeometry: geometry,
      backendGeometry: lastReportedGeometry ? { cols: lastReportedGeometry.cols, rows: lastReportedGeometry.rows } : null,
      backgroundColor: appStyle?.backgroundColor ?? null,
      foregroundColor: appStyle?.color ?? null,
      terminalBackgroundColor: terminalTheme?.background ?? hostStyle?.backgroundColor ?? null,
      terminalForegroundColor: terminalTheme?.foreground ?? hostStyle?.color ?? null,
      contrastRatio,
      bufferLineCount: bufferSummary.lineCount,
      bufferTail: bufferSummary.tail,
      lastResizeSource: lastReportedGeometry?.source ?? "unknown",
    };
  }, [
    lastReportedGeometry,
    readTerminalBuffer,
    readTerminalGeometry,
    terminalContainerRef,
    terminalRef,
    terminalViewState,
    terminalEpoch,
    theme,
    viewRevision,
    viewMode,
  ]);

  const emitIncident = useCallback((
    finding: TerminalRedlineFinding,
    status: ClientDiagnosticStatus,
    existingId?: string,
    existingAt?: string,
  ): void => {
    const diagnostic = buildDiagnosticDetails(finding, status, recentSamplesRef.current.slice(-3));
    const incident = {
      id: existingId ?? `diag-${Date.now()}-${finding.kind}`,
      at: existingAt ?? new Date().toISOString(),
      kind: finding.kind,
      severity: finding.severity,
      status,
      summary: finding.summary,
      diagnostic,
    } satisfies RuntimeTerminalRedlineIncident;

    incidentLogRef.current = trimIncidents([...incidentLogRef.current, incident]);
    setIncidentLog(incidentLogRef.current);
    persistState();
    debugLog("terminal_redline", {
      issue: finding.kind,
      severity: finding.severity,
      status,
      summary: finding.summary,
      sample: diagnostic.sample,
    });
    reportDiagnostic({
      session: attachedSession || undefined,
      tabIndex: activeTabIndex ?? undefined,
      paneId: activePaneId ?? undefined,
      diagnostic,
    });
  }, [activePaneId, activeTabIndex, attachedSession, persistState, reportDiagnostic]);

  const sampleAndDetect = useCallback((): void => {
    const current = collectSample();
    if (!current) {
      return;
    }

    recentSamplesRef.current = [
      ...recentSamplesRef.current,
      flattenTerminalDiagnosticSample(current),
    ].slice(-MAX_RECENT_SAMPLES);

    const findings = detectTerminalRedlines({
      current,
      previous: previousSampleRef.current,
      recentActions: recentActionsRef.current.slice(-6),
      protectedBufferMarkers: protectedBufferMarkersRef.current,
      historyGapSuppressed: Date.now() < historyGapSuppressedUntilRef.current,
    });
    const nextFindingMap = new Map(findings.map((finding) => [finding.kind, finding]));

    for (const finding of findings) {
      if (!activeFindingMapRef.current.has(finding.kind)) {
        const id = `diag-${Date.now()}-${finding.kind}`;
        const openedAt = new Date().toISOString();
        activeFindingMapRef.current.set(finding.kind, { finding, id, openedAt });
        emitIncident(finding, "open", id, openedAt);
      } else {
        activeFindingMapRef.current.set(finding.kind, {
          ...activeFindingMapRef.current.get(finding.kind)!,
          finding,
        });
      }
    }

    for (const [issue, active] of Array.from(activeFindingMapRef.current.entries())) {
      if (nextFindingMap.has(issue)) {
        continue;
      }
      activeFindingMapRef.current.delete(issue);
      emitIncident(active.finding, "resolved", active.id, new Date().toISOString());
    }

    setActiveIssues(
      Array.from(activeFindingMapRef.current.values()).map((active) => ({
        id: active.id,
        at: active.openedAt,
        kind: active.finding.kind,
        severity: active.finding.severity,
        status: "open",
        summary: active.finding.summary,
        diagnostic: buildDiagnosticDetails(active.finding, "open", recentSamplesRef.current.slice(-3)),
      }))
    );

    const previous = previousSampleRef.current;
    previousSampleRef.current = current;
    if (
      current.bufferLineCount >= 12
      && (!previous || current.bufferLineCount >= previous.bufferLineCount * 0.8)
    ) {
      protectedBufferMarkersRef.current = selectProtectedBufferMarkers(current.bufferTail);
    }
  }, [collectSample, emitIncident]);

  useEffect(() => {
    const handleClick = (event: Event): void => {
      const label = describeActionTarget(event.target);
      if (!label) {
        return;
      }
      recordAction("ui.click", label);
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!["Enter", "Escape", "Tab"].includes(event.key)) {
        return;
      }
      const label = describeActionTarget(event.target);
      if (!label) {
        return;
      }
      recordAction("ui.key", `${label} (${event.key})`);
    };

    document.addEventListener("click", handleClick, true);
    document.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("resize", sampleAndDetect);

    return () => {
      document.removeEventListener("click", handleClick, true);
      document.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("resize", sampleAndDetect);
    };
  }, [recordAction, sampleAndDetect]);

  useEffect(() => {
    const interval = window.setInterval(sampleAndDetect, SAMPLE_INTERVAL_MS);
    sampleAndDetect();
    return () => {
      window.clearInterval(interval);
    };
  }, [sampleAndDetect]);

  useEffect(() => {
    const nextContextKey = `${attachedSession}:${activeTabIndex ?? "none"}:${activePaneId ?? "none"}:${activeTabName}`;
    if (contextKeyRef.current && contextKeyRef.current !== nextContextKey) {
      suppressHistoryGap(`context change to ${nextContextKey}`);
    }
    contextKeyRef.current = nextContextKey;
  }, [activePaneId, activeTabIndex, activeTabName, attachedSession, suppressHistoryGap]);

  useEffect(() => {
    window.__remuxDiagnostics = {
      readState: () => ({
        activeIssues,
        incidentLog,
        recentActions: recentActionsRef.current,
      }),
    };

    return () => {
      delete window.__remuxDiagnostics;
    };
  }, [activeIssues, incidentLog]);

  const activeRedlineSummary = useMemo(() => summarizeActiveRedlines(activeIssues), [activeIssues]);

  return {
    activeIssues,
    activeRedlineCount: activeIssues.length,
    activeRedlineSummary,
    recordAction,
    suppressHistoryGap,
  };
};
