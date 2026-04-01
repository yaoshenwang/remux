/**
 * High-level workspace operations for AI workspace primitives.
 * Provides convenience functions on top of store CRUD for topics, runs, artifacts.
 */

import {
  createArtifact,
  listRuns,
  listArtifacts,
  listTopics,
  listApprovals,
  type Topic,
  type Run,
  type Artifact,
  type Approval,
} from "./store.js";
import { findTab, sessionMap } from "./session.js";

/**
 * Capture a terminal snapshot as an artifact.
 * Uses VT text snapshot if available, otherwise falls back to raw scrollback.
 */
export function captureSnapshot(
  sessionName: string,
  tabId: number,
  topicId?: string,
): { artifact: ReturnType<typeof createArtifact>; text: string } | null {
  const found = findTab(tabId);
  if (!found) return null;

  let text: string;
  if (found.tab.vt && !found.tab.ended) {
    const snapshot = found.tab.vt.textSnapshot();
    text = snapshot.text;
  } else {
    // Fallback: raw scrollback stripped of ANSI sequences
    const rawText = found.tab.scrollback.read().toString("utf8");
    text = rawText
      .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
      .replace(/\x1b\][^\x07]*\x07/g, "");
  }

  const artifact = createArtifact({
    topicId,
    sessionName,
    type: "snapshot",
    title: `Snapshot: ${found.session.name} / ${found.tab.title}`,
    content: text,
  });

  return { artifact, text };
}

/**
 * Create a command-card artifact from a completed run.
 */
export function createCommandCard(run: Run): ReturnType<typeof createArtifact> {
  const summary = [
    `Command: ${run.command || "(unknown)"}`,
    `Status: ${run.status}`,
    run.exitCode !== null ? `Exit code: ${run.exitCode}` : null,
    `Started: ${new Date(run.startedAt).toISOString()}`,
    run.endedAt ? `Ended: ${new Date(run.endedAt).toISOString()}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  return createArtifact({
    runId: run.id,
    topicId: run.topicId ?? undefined,
    sessionName: run.sessionName,
    type: "command-card",
    title: run.command || "Run",
    content: summary,
  });
}

/**
 * Get a topic summary including run count and artifact count.
 */
export function getTopicSummary(
  topic: Topic,
): {
  topic: Topic;
  runCount: number;
  artifactCount: number;
  runs: ReturnType<typeof listRuns>;
} {
  const runs = listRuns(topic.id);
  const artifacts = listArtifacts({ topicId: topic.id });
  return {
    topic,
    runCount: runs.length,
    artifactCount: artifacts.length,
    runs,
  };
}

// ── Handoff Bundle ──────────────────────────────────────────────

export interface HandoffBundle {
  timestamp: number;
  sessions: { name: string; activeTabs: number }[];
  recentRuns: Run[];
  activeTopics: Topic[];
  pendingApprovals: Approval[];
  keyArtifacts: Artifact[];
}

/**
 * Generate a handoff bundle summarizing the current workspace state.
 * Includes sessions, recent runs, active topics, pending approvals,
 * and key artifacts for context transfer between sessions.
 */
export function generateHandoffBundle(): HandoffBundle {
  const now = Date.now();
  const DAY_MS = 24 * 60 * 60 * 1000;

  // Sessions with active (non-ended) tab count
  const sessions: HandoffBundle["sessions"] = [];
  for (const session of sessionMap.values()) {
    sessions.push({
      name: session.name,
      activeTabs: session.tabs.filter((t) => !t.ended).length,
    });
  }

  // Last 10 runs
  const allRuns = listRuns();
  const recentRuns = allRuns.slice(-10).reverse();

  // Topics updated in last 24h
  const allTopics = listTopics();
  const activeTopics = allTopics.filter(
    (t) => now - t.updatedAt < DAY_MS,
  );

  // Pending approvals
  const pendingApprovals = listApprovals("pending");

  // Last 20 artifacts
  const allArtifacts = listArtifacts({});
  const keyArtifacts = allArtifacts.slice(-20).reverse();

  return {
    timestamp: now,
    sessions,
    recentRuns,
    activeTopics,
    pendingApprovals,
    keyArtifacts,
  };
}
