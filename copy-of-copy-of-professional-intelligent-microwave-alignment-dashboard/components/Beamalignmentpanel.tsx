import React, { useEffect, useRef, useState, useCallback } from 'react';

/* ─────────────────────────────────────────────────────────────────────────────
   Config — same base URL as StationPanel
───────────────────────────────────────────────────────────────────────────── */
const BASE_URL = 'http://localhost:8000';
const POLL_MS  = 2000;

/* ─────────────────────────────────────────────────────────────────────────────
   Types
───────────────────────────────────────────────────────────────────────────── */
interface StationSnapshot {
  azimuth:    number;
  elevation:  number;
  signal_dbm: number;
  online:     boolean;
  mode:       string;
}

interface AlignmentQuality {
  label:  string;
  color:  string;
  glow:   string;
}

/* ─────────────────────────────────────────────────────────────────────────────
   Alignment quality from signal strength
───────────────────────────────────────────────────────────────────────────── */
function alignmentQuality(dbm: number): AlignmentQuality {
  if (dbm > -99 && dbm > -50) return { label: 'Locked',   color: '#4ade80', glow: 'rgba(74,222,128,0.35)' };
  if (dbm > -65)               return { label: 'Marginal', color: '#fbbf24', glow: 'rgba(251,191,36,0.25)'  };
  if (dbm > -80)               return { label: 'Weak',     color: '#f87171', glow: 'rgba(248,113,113,0.2)'  };
  return                              { label: 'No Link',  color: '#475569', glow: 'transparent'             };
}

/* ─────────────────────────────────────────────────────────────────────────────
   Angular difference between two beam headings (0–180)
   Used to estimate how close the stations are to pointing at each other.
   Perfect alignment: A points at B (azA) and B points back (azB ≈ azA+180 or azA-180)
───────────────────────────────────────────────────────────────────────────── */
function beamDelta(azA: number, azBRaw: number): number {
  const azB  = normalizeBazimuth(azBRaw);   // flip B before comparing
  const ideal = (azA + 180) % 360;
  let diff = Math.abs(azB - ideal);
  if (diff > 180) diff = 360 - diff;
  return diff;
}

function normalizeBazimuth(az: number): number {
  return (az + 180) % 360;
}

/* ─────────────────────────────────────────────────────────────────────────────
   Canvas draw
   Layout: Station A on the left, Station B on the right.
   Each dish is drawn as a cone from its base point, pointing in the direction
   of its azimuth angle (mapped to 2D: 0°=right, 90°=up, 180°=left, 270°=down).
   For the alignment illustration we only use azimuth (the horizontal sweep).
   Elevation is shown numerically — it affects the 3D real pointing but the
   2D top-down view represents the horizontal plane.
───────────────────────────────────────────────────────────────────────────── */
function draw(
  canvas: HTMLCanvasElement,
  a: StationSnapshot,
  b: StationSnapshot,
  linkColor: string,
  linkGlow:  string,
) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  // Station positions — A left, B right, vertically centred
  const AX = Math.round(W * 0.22);
  const BX = Math.round(W * 0.78);
  const CY = Math.round(H * 0.5);

  // ── Background grid (subtle) ─────────────────────────────────────────────
  ctx.strokeStyle = 'rgba(30,42,74,0.5)';
  ctx.lineWidth = 0.5;
  for (let x = 0; x < W; x += 24) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  }
  for (let y = 0; y < H; y += 24) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }

  // ── Convert azimuth → canvas angle ──────────────────────────────────────
  // Azimuth 0 = North = up on screen. We map to math angle:
  //   canvas_angle = -(az_rad - PI/2)   so that 0°→right, 90°→down, 180°→left
  // For a top-down view: 0°(North)→up, 90°(East)→right, 180°(South)→down
  const azToCanvas = (az: number) => (az - 90) * (Math.PI / 180);

  // ── Link line between stations ───────────────────────────────────────────
  ctx.save();
  if (linkGlow !== 'transparent') {
    ctx.shadowColor = linkGlow;
    ctx.shadowBlur  = 12;
  }
  ctx.strokeStyle = linkColor;
  ctx.lineWidth   = 1;
  ctx.setLineDash([3, 5]);
  ctx.globalAlpha = 0.5;
  ctx.beginPath();
  ctx.moveTo(AX, CY);
  ctx.lineTo(BX, CY);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  ctx.restore();

  // ── Draw a dish at (cx, cy) pointing in canvas-angle `angle` ─────────────
  const drawDish = (
    cx: number, cy: number,
    azDeg: number, elDeg: number,
    baseColor: string, label: string, online: boolean,
    displayAz?: number,   // raw hardware value shown in the label
  ) => {
    const angle   = azToCanvas(azDeg);
    const beamLen = Math.min(W, H) * 0.32;
    const CONE_HALF = 18 * (Math.PI / 180); // ±18° cone half-angle

    // ── Beam cone (filled) ────────────────────────────────────────────────
    const tipX = cx + Math.cos(angle) * beamLen;
    const tipY = cy + Math.sin(angle) * beamLen;
    const lX   = cx + Math.cos(angle - CONE_HALF) * beamLen * 0.85;
    const lY   = cy + Math.sin(angle - CONE_HALF) * beamLen * 0.85;
    const rX   = cx + Math.cos(angle + CONE_HALF) * beamLen * 0.85;
    const rY   = cy + Math.sin(angle + CONE_HALF) * beamLen * 0.85;

    // Cone gradient: bright at base, fades at tip
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, beamLen);
    grad.addColorStop(0,   baseColor + 'cc');
    grad.addColorStop(0.5, baseColor + '33');
    grad.addColorStop(1,   baseColor + '00');

    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(lX, lY);
    ctx.arcTo(tipX, tipY, rX, rY, 8);
    ctx.lineTo(rX, rY);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // Cone border (main beam axis)
    ctx.save();
    ctx.shadowColor = baseColor + '88';
    ctx.shadowBlur  = 6;
    ctx.strokeStyle = baseColor;
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(tipX, tipY);
    ctx.stroke();
    ctx.restore();

    // ── Sidelobe lines (faint) ────────────────────────────────────────────
    ctx.globalAlpha = 0.15;
    ctx.strokeStyle = baseColor;
    ctx.lineWidth   = 1;
    [-30, -22, 22, 30].forEach(offDeg => {
      const a2 = angle + offDeg * (Math.PI / 180);
      const l2 = beamLen * (1 - Math.abs(offDeg) / 60);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(a2) * l2, cy + Math.sin(a2) * l2);
      ctx.stroke();
    });
    ctx.globalAlpha = 1;

    // ── Dish body (circle) ────────────────────────────────────────────────
    const RADIUS = 9;
    ctx.save();
    ctx.shadowColor = baseColor + 'aa';
    ctx.shadowBlur  = online ? 10 : 0;
    ctx.fillStyle   = baseColor;
    ctx.beginPath();
    ctx.arc(cx, cy, RADIUS, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Inner dark circle
    ctx.fillStyle = '#060b18';
    ctx.beginPath();
    ctx.arc(cx, cy, RADIUS - 3, 0, Math.PI * 2);
    ctx.fill();

    // ── Label below dish ─────────────────────────────────────────────────
    ctx.fillStyle = online ? baseColor : '#475569';
    ctx.font      = 'bold 10px "IBM Plex Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText(label, cx, cy + RADIUS + 13);

    // Az / El readout
    ctx.fillStyle = '#475569';
    ctx.font      = '8px "IBM Plex Mono", monospace';
    ctx.fillText(`${(displayAz ?? azDeg).toFixed(1)}° / ${elDeg.toFixed(1)}°`, cx, cy + RADIUS + 23);

    // Offline indicator
    if (!online) {
      ctx.fillStyle = '#f87171';
      ctx.font      = '8px "IBM Plex Mono", monospace';
      ctx.fillText('OFFLINE', cx, cy + RADIUS + 33);
    }
  };

  // ── Draw compass rose (tiny, top-right) ──────────────────────────────────
  const cx = W - 22, cy_c = 22, cr = 14;
  ctx.strokeStyle = '#1e2a4a';
  ctx.lineWidth   = 1;
  ctx.beginPath();
  ctx.arc(cx, cy_c, cr, 0, Math.PI * 2);
  ctx.stroke();
  ['N','E','S','W'].forEach((d, i) => {
    const a = i * Math.PI / 2 - Math.PI / 2;
    ctx.fillStyle = d === 'N' ? '#60a5fa' : '#334155';
    ctx.font      = d === 'N' ? 'bold 7px sans-serif' : '7px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(d, cx + Math.cos(a) * (cr - 4), cy_c + Math.sin(a) * (cr - 4) + 3);
  });

  // ── Draw both stations ───────────────────────────────────────────────────
  drawDish(AX, CY, a.azimuth,                    a.elevation, '#2563eb', 'A', a.online);
  drawDish(BX, CY, normalizeBazimuth(b.azimuth), b.elevation, '#16a34a', 'B', b.online, b.azimuth);

  // ── Delta arc annotation ─────────────────────────────────────────────────
  const delta = beamDelta(a.azimuth, b.azimuth);
  const midX  = (AX + BX) / 2;
  ctx.fillStyle = '#334155';
  ctx.font      = '8px "IBM Plex Mono", monospace';
  ctx.textAlign = 'center';
  ctx.fillText(`Δ ${delta.toFixed(1)}°`, midX, CY - 8);
}

/* ─────────────────────────────────────────────────────────────────────────────
   Component
───────────────────────────────────────────────────────────────────────────── */
const BeamAlignmentPanel: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef   = useRef<HTMLDivElement>(null);

  const [a, setA] = useState<StationSnapshot>({ azimuth: 0, elevation: 0, signal_dbm: -99, online: false, mode: 'AUTO' });
  const [b, setB] = useState<StationSnapshot>({ azimuth: 0, elevation: 0, signal_dbm: -99, online: false, mode: 'AUTO' });
  const [fetchErr, setFetchErr] = useState<string | null>(null);

  // ── Fetch from /dashboard/stations ──────────────────────────────────────
  const fetchStations = useCallback(async () => {
    try {
      const res = await fetch(`${BASE_URL}/dashboard/stations`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      const parse = (sid: string): StationSnapshot | null => {
        const s = data[sid];
        if (!s) return null;
        return {
          azimuth:    s.current_angles?.azimuth    ?? 0,
          elevation:  s.current_angles?.elevation  ?? 0,
          signal_dbm: s.signal_dbm ?? -99,
          online:     s.connection?.online ?? false,
          mode:       s.mode ?? 'AUTO',
        };
      };

      const sa = parse('station_1');
      const sb = parse('station_2');
      if (sa) setA(sa);
      if (sb) setB(sb);
      setFetchErr(null);
    } catch (e: any) {
      setFetchErr(e.message);
    }
  }, []);

  useEffect(() => {
    fetchStations();
    const id = setInterval(fetchStations, POLL_MS);
    return () => clearInterval(id);
  }, [fetchStations]);

  // ── Canvas sizing + redraw ───────────────────────────────────────────────
  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const wrap   = wrapRef.current;
    if (!canvas || !wrap) return;
    canvas.width  = wrap.offsetWidth;
    canvas.height = 180;
    const q = alignmentQuality(Math.max(a.signal_dbm, b.signal_dbm));
    draw(canvas, a, b, q.color, q.glow);
  }, [a, b]);

  useEffect(() => {
    redraw();
    const ro = new ResizeObserver(redraw);
    if (wrapRef.current) ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, [redraw]);

  // ── Derived values ───────────────────────────────────────────────────────
  const bestDbm = Math.max(a.signal_dbm, b.signal_dbm);
  const quality = alignmentQuality(bestDbm);
  const delta   = beamDelta(a.azimuth, b.azimuth);
  const elDiff  = Math.abs(a.elevation - b.elevation);

  return (
    <div style={{
      background: '#0d1224',
      border: '1px solid #1e2a4a',
      borderRadius: '6px',
      padding: '14px',
      fontFamily: "'Syne', sans-serif",
      color: '#e2e8f0',
    }}>

      {/* ── Header ── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
        <span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.15em', color: '#475569', textTransform: 'uppercase' }}>
          Beam Alignment View
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <div style={{
            width: '7px', height: '7px', borderRadius: '50%',
            background: quality.color,
            boxShadow: `0 0 6px ${quality.color}`,
          }} />
          <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: '11px', color: quality.color }}>
            {quality.label}
          </span>
        </div>
      </div>

      {/* ── Error ── */}
      {fetchErr && (
        <div style={{ fontSize: '10px', color: '#f87171', marginBottom: '8px', fontFamily: "'IBM Plex Mono', monospace" }}>
          ⚠ {fetchErr}
        </div>
      )}

      {/* ── Canvas ── */}
      <div ref={wrapRef} style={{ width: '100%', marginBottom: '10px' }}>
        <canvas ref={canvasRef} style={{ display: 'block', width: '100%', borderRadius: '4px', background: '#060b18' }} />
      </div>

      {/* ── Metrics row ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: '8px', marginBottom: '12px' }}>
        {[
          { label: 'Az delta',  val: `${delta.toFixed(1)}°`,   note: delta < 10 ? 'aligned' : delta < 30 ? 'close' : 'off' },
          { label: 'El diff',   val: `${elDiff.toFixed(1)}°`,  note: elDiff < 5  ? 'matched' : 'skewed'  },
          { label: 'Signal',    val: bestDbm > -99 ? `${bestDbm.toFixed(1)}` : 'N/A', note: 'dBm' },
          { label: 'Link',      val: (a.online && b.online) ? 'Both up' : a.online ? 'A only' : b.online ? 'B only' : 'None', note: '' },
        ].map(({ label, val, note }) => (
          <div key={label} style={{ background: '#060b18', borderRadius: '4px', padding: '8px 6px', textAlign: 'center' }}>
            <div style={{ fontSize: '9px', color: '#475569', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '4px' }}>
              {label}
            </div>
            <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: '14px', fontWeight: 500, color: '#60a5fa' }}>
              {val}
            </div>
            {note && (
              <div style={{ fontSize: '8px', color: '#334155', marginTop: '2px' }}>{note}</div>
            )}
          </div>
        ))}
      </div>

      {/* ── Per-station readout ── */}
      {[
        { label: 'Station A', s: a, color: '#2563eb' },
        { label: 'Station B', s: b, color: '#16a34a' },
      ].map(({ label, s, color }) => (
        <div key={label} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: color }} />
            <span style={{ fontSize: '10px', color: '#64748b', letterSpacing: '0.06em', textTransform: 'uppercase' }}>{label}</span>
          </div>
          <div style={{ display: 'flex', gap: '14px', fontFamily: "'IBM Plex Mono', monospace", fontSize: '11px' }}>
            <span style={{ color: '#60a5fa' }}>AZ {s.azimuth.toFixed(1)}°</span>
            <span style={{ color: '#60a5fa' }}>EL {s.elevation.toFixed(1)}°</span>
            <span style={{ color: s.signal_dbm > -99 ? '#94a3b8' : '#334155' }}>
              {s.signal_dbm > -99 ? `${s.signal_dbm.toFixed(1)} dBm` : 'N/A'}
            </span>
            <span style={{
              fontSize: '9px', padding: '2px 6px', borderRadius: '3px',
              background: s.online ? '#0f2a1a' : '#1f0a0a',
              color:      s.online ? '#4ade80'  : '#f87171',
              border:     `1px solid ${s.online ? '#166534' : '#7f1d1d'}`,
            }}>
              {s.online ? 'ON' : 'OFF'}
            </span>
          </div>
        </div>
      ))}

    </div>
  );
};

export default BeamAlignmentPanel;