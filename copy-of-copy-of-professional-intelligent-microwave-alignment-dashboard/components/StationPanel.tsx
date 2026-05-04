import React, { useState, useEffect } from 'react';
import { StationData, OperationalMode } from '../types';

/* ─────────────────────────────────────────────────────────────────────────────
   Style injection — mirrors the HTML dashboard's CSS exactly
───────────────────────────────────────────────────────────────────────────── */
const STYLES = `
  @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=Syne:wght@400;500;700&display=swap');

  .ma-card {
    font-family: 'Syne', sans-serif;
    background: #0d1224;
    border: 1px solid #1e2a4a;
    border-radius: 6px;
    padding: 14px;
    color: #e2e8f0;
  }

  /* ── header ── */
  .ma-station-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 14px;
  }
  .ma-station-name {
    font-size: 14px;
    font-weight: 700;
    letter-spacing: 0.06em;
    color: #e2e8f0;
  }
  .ma-header-right { display: flex; align-items: center; gap: 10px; }

  /* ── RSSI value ── */
  .ma-rssi-val {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 22px;
    font-weight: 500;
  }
  .ma-rssi-good { color: #4ade80; }
  .ma-rssi-warn { color: #fbbf24; }
  .ma-rssi-bad  { color: #f87171; }
  .ma-rssi-none { color: #475569; }

  /* ── badge ── */
  .ma-badge {
    font-family: 'Syne', sans-serif;
    font-size: 11px;
    padding: 3px 10px;
    border-radius: 3px;
    font-weight: 500;
    letter-spacing: 0.05em;
    display: inline-flex;
    align-items: center;
  }
  .ma-badge-on  { background: #0f2a1a; color: #4ade80; border: 1px solid #166534; }
  .ma-badge-off { background: #1f0a0a; color: #f87171; border: 1px solid #7f1d1d; }
  .ma-dot {
    width: 7px; height: 7px; border-radius: 50%;
    display: inline-block; margin-right: 5px;
  }
  .ma-dot-on  { background: #4ade80; }
  .ma-dot-off { background: #f87171; }

  /* ── angle gauges ── */
  .ma-gauge-row { display: flex; gap: 16px; margin-bottom: 14px; }
  .ma-gauge-wrap { flex: 1; text-align: center; }
  .ma-gauge-label {
    font-size: 10px; color: #64748b;
    letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 6px;
  }
  .ma-gauge-val {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 18px; font-weight: 500; color: #60a5fa; margin-bottom: 4px;
  }
  .ma-angle-bar-bg  { height: 5px; background: #1e2a4a; border-radius: 2px; overflow: hidden; }
  .ma-angle-bar-fill { height: 100%; background: #2563eb; border-radius: 2px; transition: width 0.4s ease; }
  .ma-sep { width: 1px; background: #1e2a4a; align-self: stretch; }

  /* ── sliders ── */
  .ma-slider-row { margin-bottom: 10px; }
  .ma-slider-label {
    font-size: 10px; color: #475569; letter-spacing: 0.08em;
    text-transform: uppercase; margin-bottom: 5px;
    display: flex; justify-content: space-between; align-items: center;
  }
  .ma-slider-val { font-family: 'IBM Plex Mono', monospace; font-size: 12px; color: #60a5fa; }
  .ma-slider {
    width: 100%;
    accent-color: #2563eb;
    cursor: pointer;
  }
  .ma-slider:disabled { opacity: 0.35; cursor: not-allowed; }

  /* ── signal bar ── */
  .ma-sig-bar-bg { height: 4px; background: #1e2a4a; border-radius: 2px; overflow: hidden; margin: 10px 0 14px; }
  .ma-sig-bar-fill { height: 100%; border-radius: 2px; transition: width 0.5s ease; }

  /* ── pending banner ── */
  .ma-pending {
    background: #0c1a3a;
    border: 1px solid #1d4ed8;
    border-radius: 4px;
    padding: 8px 10px;
    font-size: 11px;
    font-family: 'IBM Plex Mono', monospace;
    color: #60a5fa;
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 10px;
    animation: ma-pulse 1.5s ease-in-out infinite;
  }
  @keyframes ma-pulse { 0%,100%{opacity:1} 50%{opacity:0.55} }
  .ma-spinner {
    width: 14px; height: 14px;
    border: 2px solid #2563eb;
    border-top-color: transparent;
    border-radius: 50%;
    animation: ma-spin 0.7s linear infinite;
    flex-shrink: 0;
  }
  @keyframes ma-spin { to { transform: rotate(360deg); } }

  /* ── error box ── */
  .ma-error-box {
    background: #1f0a0a;
    border: 1px solid #7f1d1d;
    border-radius: 4px;
    padding: 8px 10px;
    margin-bottom: 10px;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .ma-error-text { font-size: 11px; color: #f87171; }
  .ma-error-label { font-weight: 700; margin-right: 4px; }
  .ma-btn-reset {
    font-family: 'Syne', sans-serif;
    font-size: 10px; font-weight: 700; letter-spacing: 0.08em;
    padding: 4px 10px; border-radius: 3px; border: none; cursor: pointer;
    text-transform: uppercase;
    background: #7f1d1d; color: #f87171;
    transition: opacity 0.15s;
  }
  .ma-btn-reset:hover { opacity: 0.8; }

  /* ── mode toggle ── */
  .ma-mode-toggle {
    display: flex;
    border: 1px solid #1e2a4a;
    border-radius: 3px;
    overflow: hidden;
  }
  .ma-mode-btn {
    font-family: 'Syne', sans-serif;
    font-size: 10px; font-weight: 700; letter-spacing: 0.08em;
    padding: 5px 14px; cursor: pointer; text-transform: uppercase;
    border: none; flex: 1; text-align: center; transition: background 0.15s, color 0.15s;
  }
  .ma-mode-btn:disabled { cursor: not-allowed; }
  .ma-mode-on  { background: #1d4ed8; color: #fff; }
  .ma-mode-off { background: transparent; color: #334155; }
  .ma-mode-off:not(:disabled):hover { color: #64748b; }

  /* ── bottom row ── */
  .ma-bottom-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .ma-meta-label {
    font-size: 10px; color: #475569; text-transform: uppercase;
    letter-spacing: 0.08em; margin-bottom: 4px;
  }
  .ma-lqi-val {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 20px; font-weight: 500; color: #4ade80;
  }
  .ma-status-val {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 13px; color: #94a3b8;
  }
`;

function injectStyles() {
  if (typeof document !== 'undefined' && !document.getElementById('ma-station-styles')) {
    const el = document.createElement('style');
    el.id = 'ma-station-styles';
    el.textContent = STYLES;
    document.head.appendChild(el);
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
   Helpers
───────────────────────────────────────────────────────────────────────────── */

/** True when the backend has sent a real reading (anything above the -99 sentinel). */
function hasSignal(rssi: number) {
  return rssi > -99;
}

function rssiClass(rssi: number) {
  if (!hasSignal(rssi)) return 'ma-rssi-none';
  if (rssi > -50) return 'ma-rssi-good';
  if (rssi > -65) return 'ma-rssi-warn';
  return 'ma-rssi-bad';
}

function rssiBarColor(rssi: number) {
  if (!hasSignal(rssi)) return '#1e2a4a';
  if (rssi > -50) return '#4ade80';
  if (rssi > -65) return '#fbbf24';
  return '#f87171';
}

/** Maps -90 dBm → 0 %, -30 dBm → 100 %. Returns 0 when no reading. */
function rssiPct(rssi: number) {
  if (!hasSignal(rssi)) return 0;
  return Math.max(0, Math.min(100, ((rssi - -90) / (-30 - -90)) * 100));
}

/** Link quality index: 0–100 derived from dBm. Shows "—" when no reading yet. */
function lqiFromRssi(rssi: number): number | null {
  if (!hasSignal(rssi)) return null;
  return Math.min(100, Math.max(0, Math.round(110 + rssi)));
}

function azPct(az: number)  { return Math.min(100, Math.round((az / 180) * 100)); }
function elPct(el: number)  { return Math.min(100, Math.round((el / 90)  * 100)); }

/* ─────────────────────────────────────────────────────────────────────────────
   Default / fallback station shape
───────────────────────────────────────────────────────────────────────────── */
const DEFAULT_STATION: StationData = {
  station_id: 'station_1',
  mode: OperationalMode.AUTO,
  connection: { last_heartbeat: '', online: false },
  current_angles: { azimuth: 30, elevation: 30 },
  target_angles: null,
  command: { pending: false, issued_at: null, acknowledged: false },
  error: { has_error: false, error_code: null, error_message: null, timestamp: null },
};

/* ─────────────────────────────────────────────────────────────────────────────
   Component
───────────────────────────────────────────────────────────────────────────── */
interface StationPanelProps {
  station: StationData;
  setMode: (mode: OperationalMode) => void;
  sendManualCommand: (id: string, azimuth: number, elevation: number) => void;
  resetError: (id: string) => void;
}

const StationPanel: React.FC<StationPanelProps> = ({
  station,
  setMode,
  sendManualCommand,
  resetError,
}) => {
  injectStyles();

  const s: StationData = station ?? DEFAULT_STATION;

  const [localAz, setLocalAz] = useState(s.current_angles.azimuth);
  const [localEl, setLocalEl] = useState(s.current_angles.elevation);
  const [isDragging, setIsDragging] = useState(false);

  /* Sync angles from backend when user isn't dragging */
  useEffect(() => {
    if (!isDragging) {
      setLocalAz(s.current_angles.azimuth);
      setLocalEl(s.current_angles.elevation);
    }
  }, [s.current_angles, isDragging]);

  function handleRelease() {
    setIsDragging(false);
    sendManualCommand(s.station_id, localAz, localEl);
  }

  /*
   * RSSI source priority:
   *   1. s.signal_dbm  — live value pushed by ESP32 heartbeat (backend v2)
   *   2. -99           — sentinel meaning "no reading yet"; shown as N/A
   *
   * The old fallback `(s as any).telemetry?.rssi ?? -48` is removed because
   * it silently masked missing data with a plausible-looking fake value.
   */
  const rssi: number = (s as any).signal_dbm ?? -99;

  const online   = s.connection.online;
  const hasError = s.error.has_error;
  const pending  = s.command.pending;
  const isManual = s.mode === OperationalMode.MANUAL;
  const disabled = !online || !isManual || pending || hasError;
  const lqi      = lqiFromRssi(rssi);
  const displayName = s.station_id.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

  return (
    <div className="ma-card">

      {/* ── Header ───────────────────────────────────────────────────────── */}
      <div className="ma-station-header">
        <span className="ma-station-name">{displayName}</span>
        <div className="ma-header-right">
          <span className={`ma-rssi-val ${rssiClass(rssi)}`}>
            {hasSignal(rssi) ? `${rssi.toFixed(1)} dBm` : 'N/A'}
          </span>
          <span className={`ma-badge ${online ? 'ma-badge-on' : 'ma-badge-off'}`}>
            <span className={`ma-dot ${online ? 'ma-dot-on' : 'ma-dot-off'}`} />
            {online ? 'Online' : 'Offline'}
          </span>
        </div>
      </div>

      {/* ── Azimuth / Elevation gauge bars ──────────────────────────────── */}
      <div className="ma-gauge-row">
        <div className="ma-gauge-wrap">
          <div className="ma-gauge-label">Azimuth</div>
          <div className="ma-gauge-val">{localAz.toFixed(1)}°</div>
          <div className="ma-angle-bar-bg">
            <div className="ma-angle-bar-fill" style={{ width: `${azPct(localAz)}%` }} />
          </div>
        </div>
        <div className="ma-sep" />
        <div className="ma-gauge-wrap">
          <div className="ma-gauge-label">Elevation</div>
          <div className="ma-gauge-val">{localEl.toFixed(1)}°</div>
          <div className="ma-angle-bar-bg">
            <div className="ma-angle-bar-fill" style={{ width: `${elPct(localEl)}%` }} />
          </div>
        </div>
      </div>

      {/* ── Error banner ─────────────────────────────────────────────────── */}
      {hasError && (
        <div className="ma-error-box">
          <span className="ma-error-text">
            <span className="ma-error-label">FAULT DETECTED:</span>
            {(s.error as any).error_message ?? (s.error as any).message ?? 'Mechanical failure'}
          </span>
          <button className="ma-btn-reset" onClick={() => resetError(s.station_id)}>
            Reset
          </button>
        </div>
      )}

      {/* ── Pending command banner ───────────────────────────────────────── */}
      {pending && (
        <div className="ma-pending">
          <span>
            Command in-flight → {s.target_angles?.azimuth.toFixed(1)}° / {s.target_angles?.elevation.toFixed(1)}°
          </span>
          <div className="ma-spinner" />
        </div>
      )}

      {/* ── Manual sliders ───────────────────────────────────────────────── */}
      <div className="ma-slider-row">
        <div className="ma-slider-label">
          <span>Az</span>
          <span className="ma-slider-val">{localAz.toFixed(1)}°</span>
        </div>
        <input
          type="range" min={0} max={180} step={0.1}
          value={localAz} disabled={disabled}
          className="ma-slider"
          onMouseDown={() => setIsDragging(true)}
          onTouchStart={() => setIsDragging(true)}
          onChange={e => setLocalAz(parseFloat(e.target.value))}
          onMouseUp={handleRelease}
          onTouchEnd={handleRelease}
        />
      </div>
      <div className="ma-slider-row">
        <div className="ma-slider-label">
          <span>El</span>
          <span className="ma-slider-val">{localEl.toFixed(1)}°</span>
        </div>
        <input
          type="range" min={0} max={180} step={0.1}
          value={localEl} disabled={disabled}
          className="ma-slider"
          onMouseDown={() => setIsDragging(true)}
          onTouchStart={() => setIsDragging(true)}
          onChange={e => setLocalEl(parseFloat(e.target.value))}
          onMouseUp={handleRelease}
          onTouchEnd={handleRelease}
        />
      </div>

      {/* ── RSSI signal bar ──────────────────────────────────────────────── */}
      <div className="ma-sig-bar-bg">
        <div
          className="ma-sig-bar-fill"
          style={{ width: `${rssiPct(rssi)}%`, background: rssiBarColor(rssi) }}
        />
      </div>

      {/* ── Bottom row: Mode toggle · LQI · Status ───────────────────────── */}
      <div className="ma-bottom-row">

        <div>
          <div className="ma-meta-label">Mode</div>
          <div className="ma-mode-toggle" style={{ marginTop: 4 }}>
            {[OperationalMode.AUTO, OperationalMode.MANUAL].map(m => (
              <button
                key={m}
                className={`ma-mode-btn ${s.mode === m ? 'ma-mode-on' : 'ma-mode-off'}`}
                disabled={!online || hasError}
                onClick={() => setMode(m)}
              >
                {m}
              </button>
            ))}
          </div>
        </div>

        <div style={{ textAlign: 'center' }}>
          <div className="ma-meta-label">Link quality</div>
          <div className="ma-lqi-val" style={{ color: lqi === null ? '#475569' : '#4ade80' }}>
            {lqi !== null ? lqi : '—'}
          </div>
        </div>

        <div style={{ textAlign: 'right' }}>
          <div className="ma-meta-label">Uptime</div>
          <div className="ma-status-val">
            {hasError ? (
              <span style={{ color: '#f87171' }}>Fault</span>
            ) : online ? (
              <span style={{ color: '#4ade80' }}>Running</span>
            ) : (
              <span style={{ color: '#64748b' }}>Offline</span>
            )}
          </div>
        </div>

      </div>
    </div>
  );
};

export default StationPanel;