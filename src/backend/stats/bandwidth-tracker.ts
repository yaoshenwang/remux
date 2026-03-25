/**
 * Bandwidth and compression statistics tracker.
 *
 * Tracks raw vs compressed bytes flowing through terminal WebSocket
 * connections and state diff statistics from TerminalStateTracker.
 * Broadcasts stats to clients every few seconds.
 */

export interface BandwidthStats {
  // Per-second rates (rolling window)
  rawBytesPerSec: number;
  compressedBytesPerSec: number;
  savedPercent: number;

  // State diff stats
  fullSnapshotsSent: number;
  diffUpdatesSent: number;
  avgChangedRowsPerDiff: number;

  // Cumulative totals
  totalRawBytes: number;
  totalCompressedBytes: number;
  totalSavedBytes: number;

  // Connection
  rttMs: number | null;
  protocol: string;
}

interface Sample {
  rawBytes: number;
  compressedBytes: number;
  timestamp: number;
}

export class BandwidthTracker {
  // Rolling window samples (1 per second, keep last 10)
  private samples: Sample[] = [];
  private currentSample: Sample = { rawBytes: 0, compressedBytes: 0, timestamp: Date.now() };
  private sampleIntervalMs = 1000;

  // Cumulative
  private totalRaw = 0;
  private totalCompressed = 0;

  // Diff stats
  private _fullSnapshotsSent = 0;
  private _diffUpdatesSent = 0;
  private totalChangedRows = 0;

  // RTT
  private _rttMs: number | null = null;

  /**
   * Record raw bytes (before compression) being sent to a client.
   */
  recordRawBytes(bytes: number): void {
    this.maybeRotateSample();
    this.currentSample.rawBytes += bytes;
    this.totalRaw += bytes;
  }

  /**
   * Record compressed bytes (actual wire bytes) sent to a client.
   * Call this with the socket's bytesWritten delta.
   */
  recordCompressedBytes(bytes: number): void {
    this.maybeRotateSample();
    this.currentSample.compressedBytes += bytes;
    this.totalCompressed += bytes;
  }

  /**
   * Record a full snapshot being sent.
   */
  recordFullSnapshot(): void {
    this._fullSnapshotsSent++;
  }

  /**
   * Record a diff update with the number of changed rows.
   */
  recordDiffUpdate(changedRows: number): void {
    this._diffUpdatesSent++;
    this.totalChangedRows += changedRows;
  }

  /**
   * Update the measured RTT.
   */
  setRtt(ms: number): void {
    this._rttMs = ms;
  }

  /**
   * Get the current stats snapshot.
   */
  getStats(): BandwidthStats {
    this.maybeRotateSample();

    // Calculate per-second rates from rolling window.
    const windowMs = this.samples.length > 0
      ? Date.now() - this.samples[0].timestamp
      : this.sampleIntervalMs;
    const windowSec = Math.max(windowMs / 1000, 1);

    const windowRaw = this.samples.reduce((sum, s) => sum + s.rawBytes, 0) + this.currentSample.rawBytes;
    const windowCompressed = this.samples.reduce((sum, s) => sum + s.compressedBytes, 0) + this.currentSample.compressedBytes;

    const rawPerSec = windowRaw / windowSec;
    const compressedPerSec = windowCompressed / windowSec;
    const savedPercent = rawPerSec > 0
      ? Math.round((1 - compressedPerSec / rawPerSec) * 100)
      : 0;

    const avgChangedRows = this._diffUpdatesSent > 0
      ? Math.round((this.totalChangedRows / this._diffUpdatesSent) * 10) / 10
      : 0;

    return {
      rawBytesPerSec: Math.round(rawPerSec),
      compressedBytesPerSec: Math.round(compressedPerSec),
      savedPercent: Math.max(0, savedPercent),
      fullSnapshotsSent: this._fullSnapshotsSent,
      diffUpdatesSent: this._diffUpdatesSent,
      avgChangedRowsPerDiff: avgChangedRows,
      totalRawBytes: this.totalRaw,
      totalCompressedBytes: this.totalCompressed,
      totalSavedBytes: Math.max(0, this.totalRaw - this.totalCompressed),
      rttMs: this._rttMs,
      protocol: "wss + permessage-deflate",
    };
  }

  private maybeRotateSample(): void {
    const now = Date.now();
    if (now - this.currentSample.timestamp >= this.sampleIntervalMs) {
      this.samples.push(this.currentSample);
      // Keep last 10 samples (10-second rolling window).
      if (this.samples.length > 10) {
        this.samples.shift();
      }
      this.currentSample = { rawBytes: 0, compressedBytes: 0, timestamp: now };
    }
  }
}
