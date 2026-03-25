import { formatBytes } from "../app-status";
import type { BandwidthStats } from "../app-types";

interface BandwidthStatsModalProps {
  onClose: () => void;
  stats: BandwidthStats | null;
}

const BandwidthStatsModal = ({ onClose, stats }: BandwidthStatsModalProps) => {
  if (!stats) {
    return null;
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="card stats-card" onClick={(event) => event.stopPropagation()}>
        <div className="stats-header">
          <h2>Bandwidth Stats</h2>
          <button onClick={onClose} title="Close">×</button>
        </div>
        <div className="stats-grid">
          <div className="stats-section">
            <h3>Terminal Stream</h3>
            <div className="stats-row"><span>Raw</span><span>{formatBytes(stats.rawBytesPerSec)}/s</span></div>
            <div className="stats-row"><span>Compressed</span><span>{formatBytes(stats.compressedBytesPerSec)}/s</span></div>
            <div className="stats-row highlight"><span>Saved</span><span>{stats.savedPercent}%</span></div>
          </div>
          <div className="stats-section">
            <h3>State Diffs</h3>
            <div className="stats-row"><span>Full snapshots</span><span>{stats.fullSnapshotsSent}</span></div>
            <div className="stats-row"><span>Diff updates</span><span>{stats.diffUpdatesSent}</span></div>
            <div className="stats-row"><span>Avg rows/diff</span><span>{stats.avgChangedRowsPerDiff}</span></div>
          </div>
          <div className="stats-section">
            <h3>Totals</h3>
            <div className="stats-row"><span>Raw data</span><span>{formatBytes(stats.totalRawBytes)}</span></div>
            <div className="stats-row"><span>Transferred</span><span>{formatBytes(stats.totalCompressedBytes)}</span></div>
            <div className="stats-row highlight"><span>Saved</span><span>{formatBytes(stats.totalSavedBytes)}</span></div>
          </div>
          <div className="stats-section">
            <h3>Connection</h3>
            <div className="stats-row"><span>RTT</span><span>{stats.rttMs !== null ? `${stats.rttMs}ms` : "measuring..."}</span></div>
            <div className="stats-row"><span>Protocol</span><span>{stats.protocol}</span></div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default BandwidthStatsModal;
