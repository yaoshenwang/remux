import type { SnippetRecord as Snippet } from "./snippets";

export interface ServerConfig {
  version?: string;
  passwordRequired: boolean;
  scrollbackLines: number;
  pollIntervalMs: number;
  uploadMaxSize?: number;
  backendKind?: "tmux" | "zellij" | "conpty";
}

export interface PendingSnippetExecution {
  snippet: Snippet;
  variables: string[];
  values: Record<string, string>;
}

export interface BandwidthStats {
  rawBytesPerSec: number;
  compressedBytesPerSec: number;
  savedPercent: number;
  fullSnapshotsSent: number;
  diffUpdatesSent: number;
  avgChangedRowsPerDiff: number;
  totalRawBytes: number;
  totalCompressedBytes: number;
  totalSavedBytes: number;
  rttMs: number | null;
  protocol: string;
}
