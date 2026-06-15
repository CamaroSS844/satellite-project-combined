import React, { useState, useEffect, useRef } from 'react';
import { StationData, OperationalMode } from '../types';

/* ─────────────────────────────────────────────────────────────────────────────
   Style injection
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
  .ma-rssi-val {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 22px;
    font-weight: 500;
  }
  .ma-rssi-good { color: #4ade80; }
  .ma-rssi-warn { color: #fbbf24; }
  .ma-rssi-bad  { color: #f87171; }
  .ma-rssi-none { color: #475569; }
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
  .ma-slider-row { margin-bottom: 10px; }
  .ma-slider-label {
    font-size: 10px; color: #475569; letter-spacing: 0.08em;
    text-transform: uppercase; margin-bottom: 5px;
    display: flex; justify-content: space-between; align-items: center;
  }
  .ma-slider-val { font-family: 'IBM Plex Mono', monospace; font-size: 12px; color: #60a5fa; }
  .ma-slider { width: 100%; accent-color: #2563eb; cursor: pointer; }
  .ma-slider:disabled { opacity: 0.35; cursor: not-allowed; }
  .ma-sig-bar-bg { height: 4px; background: #1e2a4a; border-radius: 2px; overflow: hidden; margin: 10px 0 14px; }
  .ma-sig-bar-fill { height: 100%; border-radius: 2px; transition: width 0.5s ease; }
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

  /* ── signal history graph ── */
  .ma-hist-wrap { margin-top: 14px; }
  .ma-hist-header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    margin-bottom: 5px;
  }
  .ma-hist-title {
    font-size: 10px;
    color: #475569;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .ma-hist-live {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 10px;
    color: #475569;
  }
  .ma-hist-canvas-wrap {
    position: relative;
    width: 100%;
    height: 72px;
  }
  .ma-hist-canvas {
    display: block;
    width: 100%;
    height: 100%;
    border-radius: 3px;
    background: #060b18;
  }
  .ma-hist-yaxis {
    position: absolute;
    top: 0; left: 0; bottom: 0;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    padding: 2px 0;
    pointer-events: none;
  }
  .ma-hist-ylabel {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 8px;
    color: #1e3a5a;
    line-height: 1;
    padding-left: 3px;
  }
  .ma-hist-xaxis {
    display: flex;
    justify-content: space-between;
    margin-top: 2px;
  }
  .ma-hist-xlabel {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 8px;
    color: #1e3a5a;
  }
  .ma-link-status {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 10px;
    font-size: 11px;
  }
  .ma-link-status-left {
    display: flex; align-items: center; gap: 6px;
  }
  .ma-link-phase {
    font-family: 'Syne', sans-serif;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    font-size: 10px;
  }
  .ma-link-progress-bg {
    height: 4px; width: 70px; background: #1e2a4a;
    border-radius: 2px; overflow: hidden;
  }
  .ma-link-progress-fill {
    height: 100%; border-radius: 2px; transition: width 0.4s ease;
  }
  .ma-link-pct {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 10px; color: #94a3b8;
  }
  .ma-link-variance {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 10px; color: #64748b;
  }

  .ma-override-banner {
    background: #2a1505;
    border: 1px solid #92400e;
    border-radius: 4px;
    padding: 8px 10px;
    margin-bottom: 10px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 11px;
    font-family: 'IBM Plex Mono', monospace;
    color: #fbbf24;
    animation: ma-pulse 1.5s ease-in-out infinite;
  }
  .ma-override-label {
    font-family: 'Syne', sans-serif;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    font-size: 10px;
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
   Types for the time-series history
───────────────────────────────────────────────────────────────────────────── */
interface Sample {
  ts: number;   // Date.now() ms
  dbm: number;
}

const MAX_SAMPLES = 4500;  // keep last 120 points (~2 min at 1 s cadence)

/* ─────────────────────────────────────────────────────────────────────────────
   Canvas draw — dBm vs wall-clock time
───────────────────────────────────────────────────────────────────────────── */
function drawGraph(
  canvas: HTMLCanvasElement,
  samples: Sample[],
  lineColor: string,
) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  // Fixed dBm range
  const DBM_MIN = -30;
  const DBM_MAX = 1;
  const DBM_RANGE = DBM_MAX - DBM_MIN;

  const toY = (dbm: number) =>
    H - Math.max(0, Math.min(1, (dbm - DBM_MIN) / DBM_RANGE)) * H;

  // ── grid lines at every 10 dBm ──────────────────────────────────────────
  ctx.strokeStyle = 'rgba(255,255,255,0.04)';
  ctx.lineWidth = 1;
  for (let v = DBM_MIN; v <= DBM_MAX; v += 10) {
    const y = toY(v);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }

  if (samples.length < 2) return;

  // ── time axis ────────────────────────────────────────────────────────────
  const t0 = samples[0].ts;
  const t1 = samples[samples.length - 1].ts;
  const tRange = t1 - t0 || 1;
  const toX = (ts: number) => ((ts - t0) / tRange) * W;

  // ── subtle area fill ─────────────────────────────────────────────────────
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, lineColor + '22');
  grad.addColorStop(1, lineColor + '00');
  ctx.beginPath();
  samples.forEach((s, i) => {
    const x = toX(s.ts);
    const y = toY(s.dbm);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.lineTo(toX(samples[samples.length - 1].ts), H);
  ctx.lineTo(toX(samples[0].ts), H);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // ── signal line ──────────────────────────────────────────────────────────
  ctx.beginPath();
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  samples.forEach((s, i) => {
    const x = toX(s.ts);
    const y = toY(s.dbm);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // ── dot at latest reading ────────────────────────────────────────────────
  const last = samples[samples.length - 1];
  ctx.beginPath();
  ctx.arc(toX(last.ts), toY(last.dbm), 3, 0, Math.PI * 2);
  ctx.fillStyle = lineColor;
  ctx.fill();
}

/* ─────────────────────────────────────────────────────────────────────────────
   Helpers
───────────────────────────────────────────────────────────────────────────── */
function hasSignal(rssi: number) { return rssi > -99; }

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

function rssiPct(rssi: number) {
  if (!hasSignal(rssi)) return 0;
  return Math.max(0, Math.min(100, ((rssi - -90) / 60) * 100));
}

function lqiFromRssi(rssi: number): number | null {
  if (!hasSignal(rssi)) return null;
  return Math.min(100, Math.max(0, Math.round(110 + rssi)));
}

function azPct(az: number)  { return Math.min(100, Math.round((az / 180) * 100)); }
function elPct(el: number)  { return Math.min(100, Math.round((el / 90)  * 100)); }

function fmtTime(ts: number) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

/* ─────────────────────────────────────────────────────────────────────────────
   Default station
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

  const s = station ?? DEFAULT_STATION;
  const online  = s.connection.online;
  const rssi    = (s as any).signal_dbm ?? -99 as number;

  const [localAz, setLocalAz] = useState(s.current_angles.azimuth);
  const [localEl, setLocalEl] = useState(s.current_angles.elevation);
  const [isDragging, setIsDragging] = useState(false);

  // ── Time-series history ─────────────────────────────────────────────────
  // Each entry is { ts: epoch-ms, dbm: number }.
  // We append a new sample every time `rssi` changes to a valid value.
  const samplesRef = useRef<Sample[]>([]);
  const [samples, setSamples] = useState<Sample[]>([]);

  
  
  function phaseLabel(phase: string | null, pct: number) {
  switch (phase) {
    case 'COARSE': return `Sweeping ${pct.toFixed(0)}%`;
    case 'REFINE': return `Refining ${pct.toFixed(0)}%`;
    case 'LOCK':   return 'Locked';
    case 'IDLE':   return 'Waiting';
    default:       return '—';
  }
}

  function phaseColor(phase: string | null) {
    switch (phase) {
      case 'COARSE': return '#fbbf24'; // amber — searching
      case 'REFINE':  return '#60a5fa'; // blue — narrowing
      case 'LOCK':    return '#4ade80'; // green — done
      default:        return '#475569';
    }
  }

  // Append live RSSI every time the prop changes (parent polls backend)
  useEffect(() => {
    if (!hasSignal(rssi)) return;
    const entry: Sample = { ts: Date.now(), dbm: rssi };
    samplesRef.current = [...samplesRef.current, entry].slice(-MAX_SAMPLES);
    setSamples([...samplesRef.current]);
  }, [rssi]);  // fires on every new rssi value



  // ── Canvas draw ─────────────────────────────────────────────────────────
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lineColor = s.station_id === 'station_1' ? '#2563eb' : '#16a34a';

  const onsiteOverride   = (s as any).onsite_override as boolean | undefined;
  const overrideStarted  = (s as any).override_started_at as string | null | undefined;

  function fmtOverrideDuration(startedAt: string | null | undefined) {
    if (!startedAt) return null;
    const start = new Date(startedAt).getTime();
    const now = Date.now();
    const mins = Math.max(0, Math.floor((now - start) / 60000));
    return mins < 1 ? 'just now' : `${mins} min ago`;
  }

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    function syncAndDraw() {
      const parent = canvas!.parentElement;
      const w = (parent?.offsetWidth || 300);
      canvas!.width  = w;
      canvas!.height = 72;
      drawGraph(canvas!, samplesRef.current, lineColor);
    }

    syncAndDraw();

    const ro = new ResizeObserver(syncAndDraw);
    ro.observe(canvas.parentElement ?? canvas);
    return () => ro.disconnect();
  }, [samples, lineColor]);

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

  const optimSweeping = (s as any).optim_sweeping as boolean ?? false;
const optimConverged = (s as any).optim_converged as boolean ?? false;

const sweepTotal = (s as any).optim_sweep_total ?? 0;
const sweepRemaining = (s as any).optim_sweep_remaining ?? 0;

const progressPct =
  sweepTotal > 0
    ? ((sweepTotal - sweepRemaining) / sweepTotal) * 100
    : 0;

const lockVariance =
  (s as any).optim_lock_peak_variance as number | undefined;

function getOptimPhase(
  sweeping: boolean,
  converged: boolean
): 'SWEEP' | 'REFINE' | 'LOCK' {
  if (converged) return 'LOCK';
  if (sweeping) return 'SWEEP';
  return 'REFINE';
}

const optimPhase = getOptimPhase(
  optimSweeping,
  optimConverged
);

function phaseLabel(
  phase: 'SWEEP' | 'REFINE' | 'LOCK',
  pct: number
) {
  switch (phase) {
    case 'SWEEP':
      return `Sweep ${pct.toFixed(0)}%`;

    case 'REFINE':
      return `Refining`;

    case 'LOCK':
      return 'Locked';

    default:
      return 'Waiting';
  }
}

function phaseColor(
  phase: 'SWEEP' | 'REFINE' | 'LOCK'
) {
  switch (phase) {
    case 'SWEEP':
      return '#fbbf24';

    case 'REFINE':
      return '#60a5fa';

    case 'LOCK':
      return '#4ade80';

    default:
      return '#475569';
  }
}
  const hasError = s.error.has_error;
  const pending  = s.command.pending;
  const isManual = s.mode === OperationalMode.MANUAL;
  const disabled = !online || !isManual || pending || hasError || !!onsiteOverride;
  const lqi      = lqiFromRssi(rssi);
  const displayName = s.station_id.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

  const firstTs = samples.length > 0 ? fmtTime(samples[0].ts) : null;
  const lastTs  = samples.length > 0 ? fmtTime(samples[samples.length - 1].ts) : null;

  

  return (
    <div className="ma-card">

      {/* ── Header ── */}
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

      {/* ── On-site override banner ── */}
      {onsiteOverride && (
        <div className="ma-override-banner">
          <span>
            <span className="ma-override-label">⚠ TECHNICIAN ON SITE — </span>
            Manual override active{overrideStarted ? ` (${fmtOverrideDuration(overrideStarted)})` : ''}
          </span>
        </div>
      )}

      {/* ── Link status: sweep / refine / lock ── */}
      <div className="ma-link-status">
  <div className="ma-link-status-left">
    <span className="ma-dot" style={{ background: phaseColor(optimPhase) }} />
    <span className="ma-link-phase" style={{ color: phaseColor(optimPhase) }}>
      {phaseLabel(optimPhase, progressPct)}
    </span>
  </div>

  {optimPhase === 'LOCK' ? (
    <span className="ma-link-variance">
      Δ from peak: {lockVariance != null ? `${lockVariance.toFixed(2)} dB` : '—'}
    </span>
  ) : optimPhase === 'IDLE' || optimPhase == null ? (
    <span className="ma-link-variance">Waiting for both stations…</span>
  ) : (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <div className="ma-link-progress-bg">
        <div className="ma-link-progress-fill"
          style={{
            width: `${progressPct}%`,
            background: phaseColor(optimPhase),
          }} />
      </div>
      <span className="ma-link-pct">{progressPct.toFixed(0)}%</span>
    </div>
  )}
</div>

      {/* ── Angle gauges ── */}
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

      {/* ── Error banner ── */}
      {hasError && (
        <div className="ma-error-box">
          <span className="ma-error-text">
            <span className="ma-error-label">FAULT DETECTED:</span>
            {(s.error as any).error_message ?? (s.error as any).message ?? 'Mechanical failure'}
          </span>
          <button className="ma-btn-reset" onClick={() => resetError(s.station_id)}>Reset</button>
        </div>
      )}

      {/* ── Pending banner ── */}
      {pending && (
        <div className="ma-pending">
          <span>
            Command in-flight → {s.target_angles?.azimuth.toFixed(1)}° / {s.target_angles?.elevation.toFixed(1)}°
          </span>
          <div className="ma-spinner" />
        </div>
      )}

      {/* ── Sliders ── */}
      <div className="ma-slider-row">
        <div className="ma-slider-label">
          <span>Az</span>
          <span className="ma-slider-val">{localAz.toFixed(1)}°</span>
        </div>
        <input type="range" min={0} max={180} step={0.1}
          value={localAz} disabled={disabled} className="ma-slider"
          onMouseDown={() => setIsDragging(true)}
          onTouchStart={() => setIsDragging(true)}
          onChange={e => setLocalAz(parseFloat(e.target.value))}
          onMouseUp={handleRelease} onTouchEnd={handleRelease} />
      </div>
      <div className="ma-slider-row">
        <div className="ma-slider-label">
          <span>El</span>
          <span className="ma-slider-val">{localEl.toFixed(1)}°</span>
        </div>
        <input type="range" min={0} max={180} step={0.1}
          value={localEl} disabled={disabled} className="ma-slider"
          onMouseDown={() => setIsDragging(true)}
          onTouchStart={() => setIsDragging(true)}
          onChange={e => setLocalEl(parseFloat(e.target.value))}
          onMouseUp={handleRelease} onTouchEnd={handleRelease} />
      </div>

      {/* ── RSSI bar ── */}
      <div className="ma-sig-bar-bg">
        <div className="ma-sig-bar-fill"
          style={{ width: `${rssiPct(rssi)}%`, background: rssiBarColor(rssi) }} />
      </div>

      {/* ── Bottom row ── */}
      <div className="ma-bottom-row">
        <div>
          <div className="ma-meta-label">Mode</div>
          <div className="ma-mode-toggle" style={{ marginTop: 4 }}>
            {[OperationalMode.AUTO, OperationalMode.MANUAL].map(m => (
              <button key={m}
                className={`ma-mode-btn ${s.mode === m ? 'ma-mode-on' : 'ma-mode-off'}`}
                disabled={!online || hasError || !!onsiteOverride}
                onClick={() => setMode(m)}>
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
            {hasError
              ? <span style={{ color: '#f87171' }}>Fault</span>
              : online
                ? <span style={{ color: '#4ade80' }}>Running</span>
                : <span style={{ color: '#64748b' }}>Offline</span>}
          </div>
        </div>
      </div>

      {/* ── Signal history graph — dBm vs time ── */}
      <div className="ma-hist-wrap">
        <div className="ma-hist-header">
          <span className="ma-hist-title">
            
            Signal · dBm vs time 
            
            </span>
          <span className="ma-hist-live">
            {samples.length > 0
              ? `${samples[samples.length - 1].dbm.toFixed(1)} dBm · ${samples.length} pts`
              : 'waiting…'}
          </span>
        </div>

        <div className="ma-hist-canvas-wrap">
          {/* y-axis labels */}
          <canvas ref={canvasRef} className="ma-hist-canvas" />
        </div>

        {/* x-axis time labels */}
        <div className="ma-hist-xaxis">
          <span className="ma-hist-xlabel">{firstTs ?? '—'}</span>
          <span className="ma-hist-xlabel">{lastTs ?? '—'}</span>
        </div>
      </div>

    </div>
  );
};

export default StationPanel;