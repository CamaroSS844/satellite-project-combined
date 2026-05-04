import React, { useState, useEffect } from 'react';
import { KPIs, StationData, OperationalMode } from '../types';

/* ─────────────────────────────────────────────────────────────────────────────
   Shared design tokens – mirrors the HTML dashboard's CSS variables
───────────────────────────────────────────────────────────────────────────── */
const styles = `
  @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=Syne:wght@400;500;700&display=swap');

  .ma-card {
    font-family: 'Syne', sans-serif;
    background: #0d1224;
    border: 1px solid #1e2a4a;
    border-radius: 6px;
    padding: 14px;
    color: #e2e8f0;
  }
  .ma-card-title {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.15em;
    color: #475569;
    text-transform: uppercase;
    margin: 0 0 12px;
  }
  .ma-mono { font-family: 'IBM Plex Mono', monospace; }

  /* KPI grid */
  .ma-kpi-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .ma-kpi {
    background: #060b18;
    border-radius: 4px;
    padding: 10px 12px;
  }
  .ma-kpi-label {
    font-size: 10px;
    color: #475569;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    margin-bottom: 4px;
  }
  .ma-kpi-num {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 17px;
    font-weight: 500;
    color: #e2e8f0;
  }
  .ma-kpi-sub      { font-size: 10px; color: #4ade80; margin-top: 2px; }
  .ma-kpi-sub-warn { font-size: 10px; color: #fbbf24; margin-top: 2px; }
  .ma-kpi-sub-bad  { font-size: 10px; color: #f87171; margin-top: 2px; }

  /* Station panel */
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
  .ma-rssi-val {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 22px;
    font-weight: 500;
  }
  .ma-rssi-good   { color: #4ade80; }
  .ma-rssi-warn   { color: #fbbf24; }
  .ma-rssi-bad    { color: #f87171; }

  .ma-badge {
    font-family: 'Syne', sans-serif;
    font-size: 11px;
    padding: 3px 10px;
    border-radius: 3px;
    font-weight: 500;
    letter-spacing: 0.05em;
  }
  .ma-badge-on  { background: #0f2a1a; color: #4ade80; border: 1px solid #166534; }
  .ma-badge-off { background: #1f0a0a; color: #f87171; border: 1px solid #7f1d1d; }
  .ma-online-dot {
    width: 7px; height: 7px; border-radius: 50%;
    background: #4ade80; display: inline-block; margin-right: 5px;
  }
  .ma-offline-dot {
    width: 7px; height: 7px; border-radius: 50%;
    background: #f87171; display: inline-block; margin-right: 5px;
  }

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
  .ma-angle-bar-fill { height: 100%; background: #2563eb; border-radius: 2px; }
  .ma-sep { width: 1px; background: #1e2a4a; }

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
    border: none; flex: 1; text-align: center; transition: background 0.15s;
  }
  .ma-mode-on  { background: #1d4ed8; color: #fff; }
  .ma-mode-off { background: transparent; color: #334155; }

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

  .ma-btn {
    font-family: 'Syne', sans-serif;
    font-size: 11px; font-weight: 700; letter-spacing: 0.08em;
    padding: 6px 14px; border-radius: 3px; border: none; cursor: pointer; text-transform: uppercase;
    transition: opacity 0.15s;
  }
  .ma-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .ma-btn-active { background: #166534; color: #4ade80; }
  .ma-btn-manual { background: #1e2a4a; color: #64748b; }
  .ma-btn-danger { background: #7f1d1d; color: #f87171; }

  .ma-slider-label {
    font-size: 10px; color: #475569; letter-spacing: 0.08em;
    text-transform: uppercase; margin-bottom: 4px;
    display: flex; justify-content: space-between;
  }
  .ma-slider-val { font-family: 'IBM Plex Mono', monospace; font-size: 12px; color: #60a5fa; }
  .ma-slider { width: 100%; accent-color: #2563eb; }

  .ma-signal-bar-bg { height: 4px; background: #1e2a4a; border-radius: 2px; overflow: hidden; margin-top: 8px; }
  .ma-signal-bar-fill { height: 100%; border-radius: 2px; transition: width 0.5s ease; }

  .ma-pending-banner {
    background: #0c1a3a;
    border: 1px solid #1d4ed8;
    border-radius: 4px;
    padding: 8px 10px;
    font-size: 11px;
    color: #60a5fa;
    display: flex;
    align-items: center;
    justify-content: space-between;
    animation: pulse 1.5s ease-in-out infinite;
  }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.6} }

  .ma-spinner {
    width: 14px; height: 14px;
    border: 2px solid #2563eb;
    border-top-color: transparent;
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .ma-divider { width: 1px; background: #1e2a4a; align-self: stretch; }
  .ma-uptime-label {
    font-size: 10px; color: #475569; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 4px;
  }
  .ma-uptime-val { font-family: 'IBM Plex Mono', monospace; font-size: 13px; color: #94a3b8; }
  .ma-lqi-val { font-family: 'IBM Plex Mono', monospace; font-size: 20px; font-weight: 500; color: #4ade80; }
`;

function injectStyles() {
  if (typeof document !== 'undefined' && !document.getElementById('ma-styles')) {
    const el = document.createElement('style');
    el.id = 'ma-styles';
    el.textContent = styles;
    document.head.appendChild(el);
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
   KPI Panel
───────────────────────────────────────────────────────────────────────────── */

interface KpiItem {
  label: string;
  value: string;
  sub: string;
  subType?: 'good' | 'warn' | 'bad';
}

interface KpiPanelProps {
  kpis: KPIs;
}

function buildKpiItems(kpis: KPIs): KpiItem[] {
  const avg = kpis.avgSignalQuality;
  const avgSub = avg >= 80 ? 'good' : avg >= 55 ? 'warn' : 'bad';

  const re = kpis.realignmentsPerHour;
  const reSub = re <= 5 ? 'good' : re <= 15 ? 'warn' : 'bad';

  const dt = kpis.downtimeReduction;
  const dtSub: 'good' | 'warn' | 'bad' = dt >= 1 ? 'good' : dt >= 0 ? 'warn' : 'bad';

  const pw = kpis.powerUsage;
  const pwSub: 'good' | 'warn' | 'bad' = pw <= 1.5 ? 'good' : pw <= 3 ? 'warn' : 'bad';

  return [
    { label: 'Avg signal', value: avg.toFixed(1), sub: `% — ${avgSub}`, subType: avgSub },
    { label: 'Realignments', value: re.toFixed(1), sub: '/ hr', subType: reSub },
    { label: 'Downtime reduction', value: dt.toFixed(2), sub: '% saved', subType: dtSub },
    { label: 'Power usage', value: pw.toFixed(2), sub: 'kWh', subType: pwSub },
  ];
}

export const KpiPanel: React.FC<KpiPanelProps> = ({ kpis }) => {
  injectStyles();
  const items = buildKpiItems(kpis);

  return (
    <div className="ma-card">
      <div className="ma-card-title">Key performance indicators</div>
      <div className="ma-kpi-grid">
        {items.map((item) => (
          <div key={item.label} className="ma-kpi">
            <div className="ma-kpi-label">{item.label}</div>
            <div className="ma-kpi-num">{item.value}</div>
            <div className={
              item.subType === 'warn' ? 'ma-kpi-sub-warn'
              : item.subType === 'bad' ? 'ma-kpi-sub-bad'
              : 'ma-kpi-sub'
            }>
              {item.sub}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default KpiPanel;


/* ─────────────────────────────────────────────────────────────────────────────
   Station Panel
───────────────────────────────────────────────────────────────────────────── */

interface StationPanelProps {
  station: StationData;
  setMode: (mode: OperationalMode) => void;
  sendManualCommand: (id: string, azimuth: number, elevation: number) => void;
  resetError: (id: string) => void;
}

function getRssiClass(rssi: number) {
  if (rssi > -50) return 'ma-rssi-good';
  if (rssi > -65) return 'ma-rssi-warn';
  return 'ma-rssi-bad';
}

function getRssiBarColor(rssi: number) {
  if (rssi > -50) return '#4ade80';
  if (rssi > -65) return '#fbbf24';
  return '#f87171';
}

function azPct(az: number) { return Math.round((az / 180) * 100); }
function elPct(el: number) { return Math.round((el / 90) * 100); }
function rssiPct(rssi: number) { return Math.max(0, Math.min(100, ((rssi - -90) / (-30 - -90)) * 100)); }

export const StationPanel: React.FC<StationPanelProps> = ({
  station, setMode, sendManualCommand, resetError,
}) => {
  injectStyles();

  const fallback: StationData = {
    station_id: 'station_1',
    mode: OperationalMode.AUTO,
    connection: { last_heartbeat: '', online: false },
    current_angles: { azimuth: 30, elevation: 30 },
    target_angles: null,
    command: { pending: false, issued_at: null, acknowledged: false },
    error: { has_error: false, error_code: null, error_message: null, timestamp: null },
  };

  const s = station ?? fallback;
  const rssi: number = (s as any).telemetry?.rssi ?? -48;

  const [localAz, setLocalAz] = useState(s.current_angles.azimuth);
  const [localEl, setLocalEl] = useState(s.current_angles.elevation);
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    if (!isDragging) {
      setLocalAz(s.current_angles.azimuth);
      setLocalEl(s.current_angles.elevation);
    }
  }, [s.current_angles, isDragging]);

  const online = s.connection.online;
  const isManual = s.mode === OperationalMode.MANUAL;
  const hasError = s.error.has_error;
  const pending = s.command.pending;
  const disabled = !online || !isManual || pending || hasError;

  const displayName = s.station_id.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

  function handleRelease() {
    setIsDragging(false);
    sendManualCommand(s.station_id, localAz, localEl);
  }

  const lqi = Math.min(100, Math.max(0, Math.round(110 + rssi)));

  return (
    <div className="ma-card">
      {/* Header */}
      <div className="ma-station-header">
        <span className="ma-station-name">{displayName}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className={`ma-rssi-val ${getRssiClass(rssi)}`}>{rssi.toFixed(1)} dBm</span>
          <span className={`ma-badge ${online ? 'ma-badge-on' : 'ma-badge-off'}`}>
            <span className={online ? 'ma-online-dot' : 'ma-offline-dot'} />
            {online ? 'Online' : 'Offline'}
          </span>
        </div>
      </div>

      {/* Azimuth / Elevation gauges */}
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

      {/* Error banner */}
      {hasError && (
        <div className="ma-error-box">
          <span className="ma-error-text">
            <span className="ma-error-label">FAULT:</span>
            {s.error.error_message ?? 'Mechanical failure'}
          </span>
          <button
            className="ma-btn ma-btn-danger"
            style={{ fontSize: 10, padding: '4px 10px' }}
            onClick={() => resetError(s.station_id)}
          >
            Reset
          </button>
        </div>
      )}

      {/* Pending banner */}
      {pending && (
        <div className="ma-pending-banner" style={{ marginBottom: 10 }}>
          <span>
            Command in-flight → {s.target_angles?.azimuth.toFixed(1)}° / {s.target_angles?.elevation.toFixed(1)}°
          </span>
          <div className="ma-spinner" />
        </div>
      )}

      {/* Sliders */}
      <div style={{ marginBottom: 14 }}>
        {/* Az slider */}
        <div style={{ marginBottom: 8 }}>
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
            style={{ opacity: disabled ? 0.4 : 1 }}
          />
        </div>
        {/* El slider */}
        <div>
          <div className="ma-slider-label">
            <span>El</span>
            <span className="ma-slider-val">{localEl.toFixed(1)}°</span>
          </div>
          <input
            type="range" min={0} max={90} step={0.1}
            value={localEl} disabled={disabled}
            className="ma-slider"
            onMouseDown={() => setIsDragging(true)}
            onTouchStart={() => setIsDragging(true)}
            onChange={e => setLocalEl(parseFloat(e.target.value))}
            onMouseUp={handleRelease}
            onTouchEnd={handleRelease}
            style={{ opacity: disabled ? 0.4 : 1 }}
          />
        </div>
      </div>

      {/* Signal bar */}
      <div className="ma-signal-bar-bg">
        <div
          className="ma-signal-bar-fill"
          style={{ width: `${rssiPct(rssi)}%`, background: getRssiBarColor(rssi) }}
        />
      </div>

      {/* Mode + LQI + Uptime row */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 14 }}>
        <div>
          <div className="ma-uptime-label">Mode</div>
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
          <div className="ma-uptime-label">Link quality</div>
          <div className="ma-lqi-val">{lqi}</div>
        </div>

        <div style={{ textAlign: 'right' }}>
          <div className="ma-uptime-label">Status</div>
          <div className="ma-uptime-val" style={{ color: hasError ? '#f87171' : online ? '#4ade80' : '#64748b' }}>
            {hasError ? 'Fault' : online ? 'Running' : 'Offline'}
          </div>
        </div>
      </div>
    </div>
  );
};