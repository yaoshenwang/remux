/**
 * Integration module that wires all remux extensions into the server.
 *
 * This module provides hooks that plug into the existing server lifecycle
 * without modifying server-zellij.ts heavily. It integrates:
 * - TerminalStateTracker (mosh-like state diffs)
 * - NotificationManager (push notifications on bell/exit)
 * - EventWatcher (structured conversation events)
 * - Gastown detector (session enrichment)
 * - BandwidthTracker (bandwidth monitoring)
 *
 * Usage in cli-zellij.ts:
 *   const extensions = createExtensions(logger);
 *   // Pass extensions to createZellijServer
 */

import type { Router } from "express";
import { TerminalStateTracker, type TerminalSnapshot, type TerminalDiffMessage } from "./terminal-state/index.js";
import { NotificationManager } from "./notifications/push-manager.js";
import { createTerminalNotifier } from "./notifications/terminal-notifier.js";
import { EventWatcher, type ConversationEvent } from "./events/index.js";
import { BandwidthTracker, type BandwidthStats } from "./stats/index.js";
import {
  detectGastownWorkspace,
  enrichSessionWithGastown,
  type GastownSessionInfo,
} from "./gastown/index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Extensions {
  /** Express routes for push notification subscription API. */
  notificationRoutes: Router;

  /** Called when a new terminal session is created. */
  onSessionCreated(sessionName: string, cols?: number, rows?: number): void;

  /** Called with each chunk of terminal output. */
  onTerminalData(sessionName: string, data: string): void;

  /** Called when a session's terminal exits. */
  onSessionExit(sessionName: string, exitCode: number): void;

  /** Called when a session is resized. */
  onSessionResize(sessionName: string, cols: number, rows: number): void;

  /** Get a full terminal state snapshot (for client reconnection). */
  getSnapshot(sessionName: string): TerminalSnapshot | null;

  /** Get a terminal state diff (for incremental updates). */
  getDiff(sessionName: string): TerminalDiffMessage | null;

  /** Get scrollback lines from the state tracker. */
  getScrollback(sessionName: string, fromLine: number, count: number): string[];

  /** Get Gastown metadata for a session. */
  getGastownInfo(sessionName: string): GastownSessionInfo;

  /** Whether Gastown workspace was detected. */
  gastownDetected: boolean;

  /** Get structured conversation events for a session. */
  getEventWatcher(sessionId: string): EventWatcher;

  /** Record raw bytes sent (before compression). */
  recordRawBytes(bytes: number): void;

  /** Record compressed bytes sent (wire bytes). */
  recordCompressedBytes(bytes: number): void;

  /** Update RTT measurement. */
  setRtt(ms: number): void;

  /** Get current bandwidth stats. */
  getBandwidthStats(): BandwidthStats;

  /** Clean up all resources. */
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createExtensions(
  logger?: Pick<Console, "log" | "error">
): Extensions {
  const notifications = new NotificationManager(logger);
  const bandwidthTracker = new BandwidthTracker();
  const stateTrackers = new Map<string, TerminalStateTracker>();
  const terminalNotifiers = new Map<string, ReturnType<typeof createTerminalNotifier>>();
  const eventWatchers = new Map<string, EventWatcher>();

  // Detect Gastown workspace.
  const gastownWorkspace = detectGastownWorkspace();
  if (gastownWorkspace) {
    logger?.log(
      `[extensions] Gastown workspace detected at ${gastownWorkspace.root} (${gastownWorkspace.rigs.length} rigs)`
    );
  }

  return {
    notificationRoutes: notifications.createRoutes(),

    gastownDetected: gastownWorkspace !== null,

    onSessionCreated(sessionName: string, cols = 200, rows = 50): void {
      // Create state tracker for this session.
      const tracker = new TerminalStateTracker(cols, rows);
      stateTrackers.set(sessionName, tracker);

      // Create terminal notifier.
      const notifier = createTerminalNotifier(sessionName, notifications);
      terminalNotifiers.set(sessionName, notifier);

      logger?.log(`[extensions] session "${sessionName}" tracking started (${cols}x${rows})`);
    },

    onTerminalData(sessionName: string, data: string): void {
      // Track raw bytes.
      bandwidthTracker.recordRawBytes(Buffer.byteLength(data, "utf8"));

      // Feed into state tracker.
      const tracker = stateTrackers.get(sessionName);
      if (tracker) {
        tracker.write(data);
        const diff = tracker.diff();
        if (diff) {
          if (diff.full) {
            bandwidthTracker.recordFullSnapshot();
          } else {
            bandwidthTracker.recordDiffUpdate(diff.changedRows.length);
          }
        }
      }

      // Check for notification triggers.
      const notifier = terminalNotifiers.get(sessionName);
      notifier?.onData(data);
    },

    onSessionExit(sessionName: string, exitCode: number): void {
      const notifier = terminalNotifiers.get(sessionName);
      notifier?.onExit(exitCode);

      // Clean up tracker.
      const tracker = stateTrackers.get(sessionName);
      tracker?.dispose();
      stateTrackers.delete(sessionName);
      terminalNotifiers.delete(sessionName);

      // Clean up event watcher.
      const watcher = eventWatchers.get(sessionName);
      watcher?.stop();
      eventWatchers.delete(sessionName);
    },

    onSessionResize(sessionName: string, cols: number, rows: number): void {
      const tracker = stateTrackers.get(sessionName);
      tracker?.resize(cols, rows);
    },

    getSnapshot(sessionName: string): TerminalSnapshot | null {
      const tracker = stateTrackers.get(sessionName);
      return tracker?.snapshot() ?? null;
    },

    getDiff(sessionName: string): TerminalDiffMessage | null {
      const tracker = stateTrackers.get(sessionName);
      return tracker?.diff() ?? null;
    },

    getScrollback(sessionName: string, fromLine: number, count: number): string[] {
      const tracker = stateTrackers.get(sessionName);
      return tracker?.getScrollback(fromLine, count) ?? [];
    },

    getGastownInfo(sessionName: string): GastownSessionInfo {
      if (!gastownWorkspace) return {};
      return enrichSessionWithGastown(sessionName, gastownWorkspace);
    },

    getEventWatcher(sessionId: string): EventWatcher {
      let watcher = eventWatchers.get(sessionId);
      if (!watcher) {
        watcher = new EventWatcher(sessionId, logger);
        watcher.start();
        eventWatchers.set(sessionId, watcher);
      }
      return watcher;
    },

    recordRawBytes(bytes: number): void {
      bandwidthTracker.recordRawBytes(bytes);
    },

    recordCompressedBytes(bytes: number): void {
      bandwidthTracker.recordCompressedBytes(bytes);
    },

    setRtt(ms: number): void {
      bandwidthTracker.setRtt(ms);
    },

    getBandwidthStats(): BandwidthStats {
      return bandwidthTracker.getStats();
    },

    dispose(): void {
      for (const tracker of stateTrackers.values()) {
        tracker.dispose();
      }
      stateTrackers.clear();
      for (const watcher of eventWatchers.values()) {
        watcher.stop();
      }
      eventWatchers.clear();
    },
  };
}
