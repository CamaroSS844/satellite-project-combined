/**
 * GPRPanel.tsx — Gaussian Process Regressor dashboard panel
 *
 * Shows for each station:
 *   - Sweep progress bar (IN_PROGRESS) or trained badge (COMPLETE)
 *   - GPR recommended angle + confidence score
 *   - Interactive signal heatmap (az/el grid coloured by predicted dBm)
 *
 * Polling intervals
 *   - Sweep status:  2 s  (fast — user wants to watch progress bar move)
 *   - Recommend:     10 s (GPR retrains every RETRAIN_EVERY=10 new points)
 *   - Signal map:    30 s (expensive grid prediction, changes slowly)
 *
 * Props
 *   stationId   — e.g. "station_1"
 *   apiBase     — base URL, default ""  (same-origin)
 *   onApply     — optional callback when user clicks "Apply" on the recommendation
 *                 receives (stationId, az, el)
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';

/* ─────────────────────────────────────────────────────────────────────────────
   Types
───────────────────────────────────────────────────────────────────────────── */

type SweepState = 'IDLE' | 'NEEDED' | 'IN_PROGRESS' | 'COMPLETE';

interface SweepStatus {
  station_id:      string;
  state:           SweepState;
  total_positions: number;
  completed:       number;
  progress_pct:    number;
  current_target:  { az: number; el: number } | null;
  started_at:      string | null;
  finished_at:     string | null;
}

interface Recommendation {
  station_id:    string;
  trained:       boolean;
  n_samples:     number;
  trained_at:    string | null;
  best_az:       number | null;
  best_el:       number | null;
  predicted_dbm: number | null;
  confidence:    number | null;    // 0–100
  error?:        string;
}

interface MapPoint {
  az:       number;
  el:       number;
  mean_dbm: number;
  std_dbm:  number;
}

interface SignalMap {
  station_id: string;
  map:        MapPoint[];
  min_dbm:    number;
  max_dbm:    number;
}

/* ─────────────────────────────────────────────────────────────────────────────
   Styles
───────────────────────────────────────────────────────────────────────────── */

const STYLES = `
  @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=Syne:wght@400;500;700&display=swap');

  .gpr-card {
    font-family: 'Syne', sans-serif;
    background: #0d1224;
    border: 1px solid #1e2a4a;
    border-radius: 6px;
    padding: 14px;
    color: #e2e8f0;
    min-width: 0;
  }

  /* ── section header ── */
  .gpr-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
  }
  .gpr-title {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: #64748b;
  }
  .gpr-badge {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 10px;
    padding: 2px 8px;
    border-radius: 3px;
  }
  .gpr-badge-trained { background: #0f2a1a; color: #4ade80; border: 1px solid #166534; }
  .gpr-badge-sweep   { background: #0c1a3a; color: #60a5fa; border: 1px solid #1d4ed8; }
  .gpr-badge-idle    { background: #1a1a2a; color: #475569; border: 1px solid #334155; }

  /* ── sweep progress ── */
  .gpr-sweep-section { margin-bottom: 12px; }
  .gpr-sweep-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 11px;
    color: #475569;
    margin-bottom: 6px;
  }
  .gpr-sweep-target {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 11px;
    color: #60a5fa;
  }
  .gpr-progress-bg {
    height: 6px;
    background: #1e2a4a;
    border-radius: 3px;
    overflow: hidden;
  }
  .gpr-progress-fill {
    height: 100%;
    background: linear-gradient(90deg, #1d4ed8, #2563eb);
    border-radius: 3px;
    transition: width 0.6s ease;
    position: relative;
    overflow: hidden;
  }
  .gpr-progress-fill::after {
    content: '';
    position: absolute;
    top: 0; left: -100%; right: 0; bottom: 0;
    background: linear-gradient(90deg, transparent, rgba(255,255,255,0.25), transparent);
    animation: gpr-shimmer 1.5s infinite;
  }
  @keyframes gpr-shimmer { to { left: 200%; } }
  .gpr-sweep-counts {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 10px;
    color: #334155;
    text-align: right;
    margin-top: 4px;
  }

  /* ── recommendation ── */
  .gpr-rec-grid {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 8px;
    margin-bottom: 12px;
  }
  .gpr-rec-cell {
    background: #0a0f1e;
    border: 1px solid #1e2a4a;
    border-radius: 4px;
    padding: 8px;
  }
  .gpr-rec-label {
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: #334155;
    margin-bottom: 4px;
  }
  .gpr-rec-val {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 16px;
    font-weight: 500;
    color: #60a5fa;
  }
  .gpr-rec-val-sm {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 13px;
    font-weight: 500;
  }
  .gpr-conf-good { color: #4ade80; }
  .gpr-conf-warn { color: #fbbf24; }
  .gpr-conf-bad  { color: #f87171; }

  /* ── confidence bar ── */
  .gpr-conf-bar-bg {
    height: 4px;
    background: #1e2a4a;
    border-radius: 2px;
    overflow: hidden;
    margin-top: 4px;
  }
  .gpr-conf-bar-fill {
    height: 100%;
    border-radius: 2px;
    transition: width 0.5s ease, background 0.5s ease;
  }

  /* ── apply button ── */
  .gpr-apply-btn {
    width: 100%;
    font-family: 'Syne', sans-serif;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 7px 14px;
    border-radius: 4px;
    border: 1px solid #1d4ed8;
    background: #0c1a3a;
    color: #60a5fa;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
    margin-bottom: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
  }
  .gpr-apply-btn:hover:not(:disabled) {
    background: #1d4ed8;
    color: #fff;
    border-color: #2563eb;
  }
  .gpr-apply-btn:disabled {
    opacity: 0.3;
    cursor: not-allowed;
  }
  .gpr-apply-arrow { font-size: 13px; }

  /* ── heatmap ── */
  .gpr-heatmap-section { }
  .gpr-heatmap-label {
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: #334155;
    margin-bottom: 6px;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .gpr-heatmap-wrap {
    position: relative;
    border: 1px solid #1e2a4a;
    border-radius: 4px;
    overflow: hidden;
  }
  .gpr-heatmap-canvas {
    display: block;
    width: 100%;
    height: auto;
    image-rendering: pixelated;
  }
  /* axis labels */
  .gpr-heatmap-axes {
    display: flex;
    justify-content: space-between;
    font-family: 'IBM Plex Mono', monospace;
    font-size: 9px;
    color: #334155;
    margin-top: 2px;
    padding: 0 2px;
  }
  .gpr-heatmap-el-axis {
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    font-family: 'IBM Plex Mono', monospace;
    font-size: 9px;
    color: #334155;
    position: absolute;
    top: 0; bottom: 0; left: 0;
    padding: 2px 0;
    pointer-events: none;
    width: 20px;
    text-align: right;
  }
  /* legend */
  .gpr-legend {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 6px;
    font-size: 9px;
    font-family: 'IBM Plex Mono', monospace;
    color: #334155;
  }
  .gpr-legend-bar {
    flex: 1;
    height: 6px;
    border-radius: 3px;
    background: linear-gradient(90deg, #1e2a4a, #1d4ed8, #4ade80, #fbbf24, #f87171);
  }

  /* ── samples / trained-at footer ── */
  .gpr-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: 10px;
    font-family: 'IBM Plex Mono', monospace;
    font-size: 9px;
    color: #334155;
  }

  /* ── no-data state ── */
  .gpr-empty {
    text-align: center;
    padding: 24px 0;
    font-size: 11px;
    color: #334155;
  }
  .gpr-spinner-wrap {
    display: flex; align-items: center; gap: 6px;
    font-size: 11px; color: #475569; justify-content: center;
    padding: 8px 0;
  }
  .gpr-spinner {
    width: 12px; height: 12px;
    border: 2px solid #1e2a4a;
    border-top-color: #2563eb;
    border-radius: 50%;
    animation: gpr-spin 0.7s linear infinite;
    flex-shrink: 0;
  }
  @keyframes gpr-spin { to { transform: rotate(360deg); } }
`;

function injectStyles() {
  if (typeof document !== 'undefined' && !document.getElementById('gpr-panel-styles')) {
    const el = document.createElement('style');
    el.id = 'gpr-panel-styles';
    el.textContent = STYLES;
    document.head.appendChild(el);
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
   Heatmap canvas renderer
───────────────────────────────────────────────────────────────────────────── */

/**
 * dBm → RGBA colour.
 * Maps weak signal (≤-80 dBm) to deep navy, strong (-30 dBm) to bright amber/green.
 * Uses a four-stop perceptual ramp matching the legend bar.
 */
function dbmToRGBA(dbm: number, minDbm: number, maxDbm: number): [number, number, number, number] {
  const t = Math.max(0, Math.min(1, (dbm - minDbm) / Math.max(1, maxDbm - minDbm)));
  // 4-stop ramp: navy → blue → teal → green → amber
  if (t < 0.25) {
    const s = t / 0.25;
    return [Math.round(30 + 25 * s), Math.round(42 + 105 * s), Math.round(74 + 126 * s), 230];
  } else if (t < 0.5) {
    const s = (t - 0.25) / 0.25;
    return [Math.round(55 + 29 * s), Math.round(147 + 27 * s), Math.round(200 + 17 * s), 230];
  } else if (t < 0.75) {
    const s = (t - 0.5) / 0.25;
    return [Math.round(84 - 10 * s), Math.round(174 + 78 * s), Math.round(217 - 143 * s), 230];
  } else {
    const s = (t - 0.75) / 0.25;
    return [Math.round(74 + 173 * s), Math.round(252 - 100 * s), Math.round(74 - 26 * s), 230];
  }
}

function renderHeatmap(
  canvas: HTMLCanvasElement,
  mapPoints: MapPoint[],
  minDbm: number,
  maxDbm: number,
  bestAz?: number | null,
  bestEl?: number | null,
  currentAz?: number,
  currentEl?: number,
) {
  if (!mapPoints.length) return;

  const azVals = [...new Set(mapPoints.map(p => p.az))].sort((a, b) => a - b);
  const elVals = [...new Set(mapPoints.map(p => p.el))].sort((a, b) => a - b);
  const cols = azVals.length;
  const rows = elVals.length;

  // Build fast lookup
  const lookup = new Map<string, number>();
  for (const p of mapPoints) lookup.set(`${p.az}_${p.el}`, p.mean_dbm);

  const W = cols;
  const H = rows;
  canvas.width  = W;
  canvas.height = H;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const imageData = ctx.createImageData(W, H);
  const data = imageData.data;

  for (let row = 0; row < rows; row++) {
    const el = elVals[rows - 1 - row]; // flip: high el at top
    for (let col = 0; col < cols; col++) {
      const az  = azVals[col];
      const dbm = lookup.get(`${az}_${el}`) ?? minDbm;
      const [r, g, b, a] = dbmToRGBA(dbm, minDbm, maxDbm);
      const idx = (row * W + col) * 4;
      data[idx]     = r;
      data[idx + 1] = g;
      data[idx + 2] = b;
      data[idx + 3] = a;
    }
  }
  ctx.putImageData(imageData, 0, 0);

  // Draw current position marker (white cross)
  if (currentAz !== undefined && currentEl !== undefined) {
    const cx = Math.round(((currentAz - azVals[0]) / (azVals[azVals.length - 1] - azVals[0])) * (W - 1));
    const cy = Math.round((1 - (currentEl - elVals[0]) / (elVals[elVals.length - 1] - elVals[0])) * (H - 1));
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(cx - 3, cy); ctx.lineTo(cx + 3, cy); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx, cy - 3); ctx.lineTo(cx, cy + 3); ctx.stroke();
  }

  // Draw recommended position marker (bright amber circle)
  if (bestAz != null && bestEl != null) {
    const bx = Math.round(((bestAz - azVals[0]) / (azVals[azVals.length - 1] - azVals[0])) * (W - 1));
    const by = Math.round((1 - (bestEl - elVals[0]) / (elVals[elVals.length - 1] - elVals[0])) * (H - 1));
    ctx.strokeStyle = '#fbbf24';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(bx, by, 3, 0, 2 * Math.PI);
    ctx.stroke();
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
   Helpers
───────────────────────────────────────────────────────────────────────────── */

function confClass(conf: number | null): string {
  if (conf === null) return 'gpr-conf-bad';
  if (conf >= 60)    return 'gpr-conf-good';
  if (conf >= 35)    return 'gpr-conf-warn';
  return 'gpr-conf-bad';
}

function confBarColor(conf: number | null): string {
  if (conf === null) return '#334155';
  if (conf >= 60)    return '#22c55e';
  if (conf >= 35)    return '#f59e0b';
  return '#ef4444';
}

function formatTrainedAt(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch { return iso.slice(11, 16); }
}

/* ─────────────────────────────────────────────────────────────────────────────
   Component
───────────────────────────────────────────────────────────────────────────── */

interface GPRPanelProps {
  stationId:      string;
  currentAz?:     number;
  currentEl?:     number;
  apiBase?:       string;
  onApply?:       (stationId: string, az: number, el: number) => void;
  /** If true, hides the "Apply" button (e.g. station is in AUTO mode and
   *  the backend already tracks the recommendation automatically) */
  autoMode?:      boolean;
}

const GPRPanel: React.FC<GPRPanelProps> = ({
  stationId,
  currentAz,
  currentEl,
  apiBase = '',
  onApply,
  autoMode = false,
}) => {
  injectStyles();

  const [sweep,   setSweep]   = useState<SweepStatus | null>(null);
  const [rec,     setRec]     = useState<Recommendation | null>(null);
  const [sigMap,  setSigMap]  = useState<SignalMap | null>(null);
  const [loading, setLoading] = useState(true);

  const canvasRef = useRef<HTMLCanvasElement>(null);

  // ── fetchers ───────────────────────────────────────────────────────────

  const fetchSweep = useCallback(async () => {
    try {
      const r = await fetch(`${apiBase}/dashboard/sweep_status/${stationId}`);
      if (r.ok) setSweep(await r.json());
    } catch {}
  }, [stationId, apiBase]);

  const fetchRec = useCallback(async () => {
    try {
      const r = await fetch(`${apiBase}/dashboard/recommend_angles/${stationId}`);
      if (r.ok) setRec(await r.json());
    } catch {}
  }, [stationId, apiBase]);

  const fetchMap = useCallback(async () => {
    try {
      const r = await fetch(`${apiBase}/dashboard/signal_map/${stationId}`);
      if (r.ok) setSigMap(await r.json());
    } catch {}
  }, [stationId, apiBase]);

  // ── polling ────────────────────────────────────────────────────────────

  useEffect(() => {
    let alive = true;

    async function init() {
      await Promise.all([fetchSweep(), fetchRec(), fetchMap()]);
      if (alive) setLoading(false);
    }
    init();

    const sweepTimer = setInterval(fetchSweep, 2_000);
    const recTimer   = setInterval(fetchRec,  10_000);
    const mapTimer   = setInterval(fetchMap,  30_000);

    return () => {
      alive = false;
      clearInterval(sweepTimer);
      clearInterval(recTimer);
      clearInterval(mapTimer);
    };
  }, [fetchSweep, fetchRec, fetchMap]);

  // ── redraw heatmap when data or current position changes ───────────────

  useEffect(() => {
    if (!canvasRef.current || !sigMap?.map.length) return;
    renderHeatmap(
      canvasRef.current,
      sigMap.map,
      sigMap.min_dbm,
      sigMap.max_dbm,
      rec?.best_az,
      rec?.best_el,
      currentAz,
      currentEl,
    );
  }, [sigMap, rec, currentAz, currentEl]);

  // ── derived state ──────────────────────────────────────────────────────

  const isSweeping  = sweep?.state === 'IN_PROGRESS';
  const isTrained   = rec?.trained === true;
  const hasRec      = isTrained && rec?.best_az != null;
  const conf        = rec?.confidence ?? null;
  const canApply    = hasRec && !autoMode && onApply != null;

  // ── render ─────────────────────────────────────────────────────────────

  return (
    <div className="gpr-card">

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="gpr-header">
        <span className="gpr-title">GPR Signal Model</span>
        {loading ? (
          <span className="gpr-badge gpr-badge-idle">loading</span>
        ) : isSweeping ? (
          <span className="gpr-badge gpr-badge-sweep">sweeping</span>
        ) : isTrained ? (
          <span className="gpr-badge gpr-badge-trained">trained</span>
        ) : (
          <span className="gpr-badge gpr-badge-idle">no model</span>
        )}
      </div>

      {/* ── Sweep progress ─────────────────────────────────────────────── */}
      {isSweeping && sweep && (
        <div className="gpr-sweep-section">
          <div className="gpr-sweep-row">
            <span>Collecting training data&hellip;</span>
            {sweep.current_target && (
              <span className="gpr-sweep-target">
                → AZ {sweep.current_target.az}° / EL {sweep.current_target.el}°
              </span>
            )}
          </div>
          <div className="gpr-progress-bg">
            <div
              className="gpr-progress-fill"
              style={{ width: `${sweep.progress_pct}%` }}
            />
          </div>
          <div className="gpr-sweep-counts">
            {sweep.completed} / {sweep.total_positions} positions
          </div>
        </div>
      )}

      {/* ── No model yet ───────────────────────────────────────────────── */}
      {!loading && !isSweeping && !isTrained && (
        <div className="gpr-empty">
          Waiting for sweep data&hellip;
        </div>
      )}

      {/* ── Loading spinner ─────────────────────────────────────────────── */}
      {loading && (
        <div className="gpr-spinner-wrap">
          <div className="gpr-spinner" />
          <span>Loading model&hellip;</span>
        </div>
      )}

      {/* ── Recommendation grid ─────────────────────────────────────────── */}
      {hasRec && rec && (
        <>
          <div className="gpr-rec-grid">
            <div className="gpr-rec-cell">
              <div className="gpr-rec-label">Best AZ</div>
              <div className="gpr-rec-val">{rec.best_az!.toFixed(1)}°</div>
            </div>
            <div className="gpr-rec-cell">
              <div className="gpr-rec-label">Best EL</div>
              <div className="gpr-rec-val">{rec.best_el!.toFixed(1)}°</div>
            </div>
            <div className="gpr-rec-cell">
              <div className="gpr-rec-label">Predicted</div>
              <div className={`gpr-rec-val-sm ${confClass(conf)}`}>
                {rec.predicted_dbm!.toFixed(1)} dBm
              </div>
              {/* confidence bar */}
              <div className="gpr-conf-bar-bg" style={{ marginTop: 6 }}>
                <div
                  className="gpr-conf-bar-fill"
                  style={{
                    width: `${conf ?? 0}%`,
                    background: confBarColor(conf),
                  }}
                />
              </div>
              <div style={{ fontSize: 9, fontFamily: "'IBM Plex Mono', monospace", color: '#334155', marginTop: 2 }}>
                {conf !== null ? `${Math.round(conf)}% conf` : '—'}
              </div>
            </div>
          </div>

          {/* ── Apply button ─────────────────────────────────────────────── */}
          {!autoMode && (
            <button
              className="gpr-apply-btn"
              disabled={!canApply}
              onClick={() => {
                if (canApply && onApply) onApply(stationId, rec.best_az!, rec.best_el!);
              }}
            >
              <span className="gpr-apply-arrow">⇢</span>
              {autoMode ? 'AUTO tracking active' : 'Apply recommendation'}
            </button>
          )}
          {autoMode && (
            <div style={{
              fontSize: 10,
              fontFamily: "'IBM Plex Mono', monospace",
              color: '#22c55e',
              textAlign: 'center',
              marginBottom: 10,
              padding: '4px 0',
              borderTop: '1px solid #0f2a1a',
              borderBottom: '1px solid #0f2a1a',
            }}>
              ● AUTO — tracking recommendation every 60 s
            </div>
          )}
        </>
      )}

      {/* ── Signal heatmap ──────────────────────────────────────────────── */}
      {sigMap && sigMap.map.length > 0 && (
        <div className="gpr-heatmap-section">
          <div className="gpr-heatmap-label">
            <span>Signal surface (predicted dBm)</span>
            <span style={{ color: '#1d4ed8' }}>
              ● current &nbsp;
              <span style={{ color: '#fbbf24' }}>○ recommended</span>
            </span>
          </div>
          <div className="gpr-heatmap-wrap">
            <canvas
              ref={canvasRef}
              className="gpr-heatmap-canvas"
            />
          </div>
          <div className="gpr-heatmap-axes">
            <span>AZ 10°</span>
            <span style={{ color: '#1e2a4a' }}>→ azimuth</span>
            <span>150°</span>
          </div>
          <div className="gpr-legend">
            <span>{sigMap.min_dbm.toFixed(0)}</span>
            <div className="gpr-legend-bar" />
            <span>{sigMap.max_dbm.toFixed(0)} dBm</span>
          </div>
        </div>
      )}

      {/* ── Footer ──────────────────────────────────────────────────────── */}
      {isTrained && rec && (
        <div className="gpr-footer">
          <span>{rec.n_samples} samples</span>
          <span>trained {formatTrainedAt(rec.trained_at)}</span>
        </div>
      )}

    </div>
  );
};

export default GPRPanel;
