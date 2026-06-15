import React, { useEffect, useRef, useState, useCallback } from 'react';

interface PolarRadiationPanelProps {
  /** Label shown below the canvas */
  stationLabel?: string;
  /** Backend station id, e.g. "station_1" */
  stationId?: string;
  /** Base URL of the backend, e.g. "http://localhost:8000" */
  apiBaseUrl?: string;
  /**
   * Elevation tolerance (degrees) — readings within this band of the
   * "reference elevation" are used to build the azimuth-only polar slice.
   */
  elevationTolerance?: number;
  /**
   * Optional override pattern: array of [angleDeg, magnitude 0..1].
   * If provided, this is drawn instead of fetched data (useful for
   * storybook/demo/testing).
   */
  pattern?: [number, number][];
  /** Polling interval in ms (0 disables polling) */
  pollIntervalMs?: number;
}

const styles = {
  card: {
    background: '#0d1224',
    border: '1px solid #1e2a4a',
    borderRadius: '6px',
    padding: '14px',
    fontFamily: "'Syne', sans-serif",
    color: '#e2e8f0',
  } as React.CSSProperties,
  cardTitle: {
    fontSize: '10px',
    fontWeight: 700,
    letterSpacing: '0.15em',
    color: '#475569',
    textTransform: 'uppercase' as const,
    margin: '0 0 12px',
  } as React.CSSProperties,
  statusRow: {
    textAlign: 'center' as const,
    fontSize: '9px',
    color: '#475569',
    fontFamily: "'IBM Plex Mono', monospace",
    marginTop: '4px',
    letterSpacing: '0.05em',
  } as React.CSSProperties,
};

// ─────────────────────────────────────────────────────────────────────────
// Backend reading shape (subset of optimizer_reading_log columns)
// ─────────────────────────────────────────────────────────────────────────
interface OptimizerReading {
  ts: string;
  phase: string;            // COARSE | REFINE | LOCK
  step_index: number;
  commanded_az: number;
  commanded_el: number;
  reported_az: number;
  reported_el: number;
  signal_dbm: number;
  sweep_role: string;
  reason: string;
}

// Fallback pattern shown before data loads / if fetch fails — same shape
// the component shipped with originally.
const DEFAULT_PATTERN: [number, number][] = [
  [0, 1], [22.5, 0.87], [45, 0.62], [67.5, 0.28],
  [90, 0.15], [112.5, 0.22], [135, 0.55], [157.5, 0.82],
  [180, 0.95], [202.5, 0.82], [225, 0.55], [247.5, 0.22],
  [270, 0.15], [292.5, 0.28], [315, 0.62], [337.5, 0.87], [360, 1],
];

// Noise floor used to normalize dBm -> 0..1 magnitude when we don't have
// a full dynamic range to work with (e.g. only 1-2 points).
const NOISE_FLOOR_DBM = -99;

/**
 * Convert a set of COARSE-phase optimizer readings into a single-axis
 * polar pattern: [azimuth_deg, magnitude 0..1].
 *
 * - Filters to readings near `referenceEl` (the elevation the antenna is
 *   currently parked/locked at) so the slice represents one EL "row" of
 *   the AZ x EL sweep grid.
 * - Normalizes signal_dbm to 0..1 using min/max of the filtered set
 *   (falling back to NOISE_FLOOR_DBM if the set is degenerate).
 * - Sorts by azimuth and de-duplicates same-angle repeats (keeps strongest).
 * - Closes the loop (0°..360°) so the canvas polygon draws cleanly.
 */
function buildPatternFromReadings(
  readings: OptimizerReading[],
  referenceEl: number,
  elevationTolerance: number,
): [number, number][] {
  const coarse = readings.filter(r => r.phase === 'COARSE');
  if (coarse.length === 0) return [];

  // Prefer readings near the reference elevation; widen the band if that
  // leaves us with too little data to draw a meaningful shape.
  let slice = coarse.filter(
    r => Math.abs(r.commanded_el - referenceEl) <= elevationTolerance,
  );
  if (slice.length < 4) {
    slice = coarse; // fall back to the whole coarse sweep
  }

  const dbms = slice.map(r => r.signal_dbm);
  const dbmMax = Math.max(...dbms);
  const dbmMin = Math.min(NOISE_FLOOR_DBM, Math.min(...dbms));
  const range = Math.max(dbmMax - dbmMin, 1e-6);

  // Reduce to one (strongest) reading per azimuth angle
  const byAz = new Map<number, number>();
  for (const r of slice) {
    const az = ((r.commanded_az % 360) + 360) % 360;
    const mag = Math.max(0, Math.min(1, (r.signal_dbm - dbmMin) / range));
    const existing = byAz.get(az);
    if (existing === undefined || mag > existing) {
      byAz.set(az, mag);
    }
  }

  const points: [number, number][] = Array.from(byAz.entries())
    .map(([deg, mag]) => [deg, mag] as [number, number])
    .sort((a, b) => a[0] - b[0]);

  if (points.length === 0) return [];

  // Close the loop: ensure 0deg and 360deg endpoints exist so the shape
  // draws as a closed polygon rather than leaving a wedge open.
  const first = points[0];
  const last = points[points.length - 1];
  if (first[0] !== 0) points.unshift([0, first[1]]);
  if (last[0] !== 360) points.push([360, points[0][1]]);

  return points;
}

const PolarRadiationPanel: React.FC<PolarRadiationPanelProps> = ({
  stationLabel = 'Measured beam — dish A',
  stationId,
  apiBaseUrl = '',
  elevationTolerance = 10,
  pattern: patternOverride,
  pollIntervalMs = 0,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [pattern, setPattern] = useState<[number, number][]>(
    patternOverride ?? DEFAULT_PATTERN,
  );
  const [sampleCount, setSampleCount] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(!!stationId && !patternOverride);
  const [error, setError] = useState<string | null>(null);

  const fetchPattern = useCallback(async () => {
    if (!stationId) return; // nothing to fetch — caller supplied a static pattern

    try {
      const res = await fetch(
        `${apiBaseUrl}/dashboard/optimizer_readings/${stationId}?limit=500`,
      );
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      const readings: OptimizerReading[] = data?.readings ?? [];

      const coarse = readings.filter(r => r.phase === 'COARSE');
      if (coarse.length === 0) {
        setError('No sweep data yet');
        return;
      }

      // Use the most recently commanded elevation as the reference "row"
      // for the azimuth slice — this is whatever EL the antenna last swept.
      const referenceEl = coarse[0].commanded_el;

      const next = buildPatternFromReadings(readings, referenceEl, elevationTolerance);
      if (next.length > 0) {
        setPattern(next);
        setSampleCount(coarse.length);
        setError(null);
      } else {
        setError('Not enough sweep points');
      }
    } catch (e) {
      setError('Could not reach backend');
    } finally {
      setLoading(false);
    }
  }, [stationId, apiBaseUrl, elevationTolerance]);

  useEffect(() => {
    if (patternOverride) {
      setPattern(patternOverride);
      setLoading(false);
      return;
    }
    fetchPattern();

    if (pollIntervalMs > 0) {
      const id = setInterval(fetchPattern, pollIntervalMs);
      return () => clearInterval(id);
    }
  }, [fetchPattern, patternOverride, pollIntervalMs]);

  const drawPolar = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const w = c.width;
    const h = c.height;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#060b18';
    ctx.fillRect(0, 0, w, h);

    const cx = w / 2;
    const cy = h * 0.55;
    const maxR = 65;

    // Rings
    [1, 0.66, 0.33].forEach(r => {
      ctx.strokeStyle = '#1e2a4a';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, maxR * r, 0, Math.PI * 2);
      ctx.stroke();
    });

    // Ring labels (dB)
    ctx.fillStyle = '#334155';
    ctx.font = '8px IBM Plex Mono, monospace';
    ctx.textAlign = 'left';
    [['0 dB', 1], ['-3 dB', 0.66], ['-9 dB', 0.33]].forEach(([lbl, r]) => {
      ctx.fillText(lbl as string, cx + maxR * (r as number) + 2, cy - 2);
    });

    // Spoke lines at 45° intervals
    ctx.strokeStyle = '#1e2a4a';
    ctx.lineWidth = 0.5;
    for (let a = 0; a < 360; a += 45) {
      const rad = (a - 90) * (Math.PI / 180);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(rad) * maxR, cy + Math.sin(rad) * maxR);
      ctx.stroke();
    }

    // Beam pattern fill
    if (pattern.length > 0) {
      ctx.strokeStyle = '#2563eb';
      ctx.lineWidth = 2;
      ctx.beginPath();
      pattern.forEach(([deg, mag], i) => {
        const rad = (deg - 90) * (Math.PI / 180);
        const x = cx + Math.cos(rad) * mag * maxR;
        const y = cy + Math.sin(rad) * mag * maxR;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.closePath();
      ctx.stroke();
      ctx.fillStyle = 'rgba(37,99,235,0.12)';
      ctx.fill();

      // Mark actual sample points (small dots) so measured vs. interpolated
      // sections of the curve are distinguishable on a dense sweep
      ctx.fillStyle = '#60a5fa';
      pattern.forEach(([deg, mag]) => {
        const rad = (deg - 90) * (Math.PI / 180);
        const x = cx + Math.cos(rad) * mag * maxR;
        const y = cy + Math.sin(rad) * mag * maxR;
        ctx.beginPath();
        ctx.arc(x, y, 1.5, 0, Math.PI * 2);
        ctx.fill();
      });
    }

    // Cardinal labels
    ctx.textAlign = 'center';
    ctx.font = '10px Syne, sans-serif';
    [['N', 0], ['E', 90], ['S', 180], ['W', 270]].forEach(([d, angle]) => {
      const rad = ((angle as number) - 90) * (Math.PI / 180);
      ctx.fillStyle = '#475569';
      ctx.fillText(d as string, cx + Math.cos(rad) * (maxR + 12), cy + Math.sin(rad) * (maxR + 12) + 4);
    });
  }, [pattern]);

  useEffect(() => {
    drawPolar();
  }, [drawPolar]);

  // Derived stats from pattern (guard against empty pattern)
  const mainLobeMax = pattern.length > 0 ? Math.max(...pattern.map(([, m]) => m)) : 0;
  const sidelobeMax = pattern
    .filter(([deg]) => deg > 30 && deg < 330)
    .reduce((max, [, m]) => Math.max(max, m), 0);
  const beamwidthDeg = pattern.length > 0
    ? pattern.filter(([, m]) => m >= 0.707).length * (360 / pattern.length)
    : 0;
  const frontToBack = (mainLobeMax / Math.max(sidelobeMax, 0.01)) * 10;

  return (
    <div style={styles.card}>
      <div style={styles.cardTitle}>Polar Radiation Pattern</div>

      <canvas
        ref={canvasRef}
        width={200}
        height={170}
        style={{ display: 'block', margin: '0 auto', borderRadius: '4px' }}
      />

      <div style={{
        textAlign: 'center', fontSize: '10px', color: '#475569',
        fontFamily: "'IBM Plex Mono', monospace", marginTop: '6px', marginBottom: '4px',
      }}>
        {stationLabel}
      </div>

      {stationId && (
        <div style={styles.statusRow}>
          {loading
            ? 'loading sweep data…'
            : error
              ? error
              : `${sampleCount} coarse sweep points`}
        </div>
      )}

      {/* Stats row */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '6px', marginTop: '8px' }}>
        {[
          { label: 'Main lobe', value: `${(mainLobeMax * 100).toFixed(0)}%`, color: '#4ade80' },
          { label: 'Sidelobe', value: `${(sidelobeMax * 100).toFixed(0)}%`, color: '#fbbf24' },
          { label: '3dB BW', value: `~${beamwidthDeg.toFixed(0)}°`, color: '#60a5fa' },
        ].map(({ label, value, color }) => (
          <div key={label} style={{ background: '#060b18', borderRadius: '4px', padding: '8px 10px', textAlign: 'center' }}>
            <div style={{ fontSize: '9px', color: '#475569', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '3px' }}>
              {label}
            </div>
            <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: '14px', fontWeight: 500, color }}>
              {value}
            </div>
          </div>
        ))}
      </div>

      {/* Pattern quality indicator */}
      <div style={{
        marginTop: '10px', borderLeft: '3px solid #166534',
        background: '#060b18', padding: '7px 10px',
        fontSize: '11px', color: '#4ade80', lineHeight: 1.5, borderRadius: '0 3px 3px 0',
      }}>
        Pattern nominal — front-to-back ratio {frontToBack.toFixed(1)} dB
      </div>
    </div>
  );
};

export default PolarRadiationPanel;