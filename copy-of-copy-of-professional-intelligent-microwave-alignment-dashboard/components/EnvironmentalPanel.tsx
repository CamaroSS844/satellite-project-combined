import React, { useEffect, useState, useCallback, useRef } from 'react';

// ── Types matching your backend's WeatherData model ──────────────────────────
interface WeatherData {
  temperature: number;
  wind_speed: number;
  rain: number;
  humidity: number;
  pressure: number;
  fetched_at: string | null;
}

interface EnvironmentalResponse {
  station_a: WeatherData;
  station_b: WeatherData;
  user_location?: WeatherData | null;
  user_lat?: number | null;
  user_lon?: number | null;
}

interface StationLike {
  signal_dbm?: number;
}

// ── Config ───────────────────────────────────────────────────────────────────
const BACKEND_URL = import.meta.env.VITE_BACKEND_URL ?? 'http://localhost:8000';
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

// ── Design tokens (mirror the HTML dashboard exactly) ─────────────────────────
const styles = {
  card: {
    background: '#0d1224',
    border: '1px solid #1e2a4a',
    borderRadius: '6px',
    padding: '14px',
    fontFamily: "'Syne', sans-serif",
  } as React.CSSProperties,

  cardTitle: {
    fontSize: '10px',
    fontWeight: 700,
    letterSpacing: '0.15em',
    color: '#475569',
    textTransform: 'uppercase' as const,
    margin: '0 0 12px',
  } as React.CSSProperties,

  kpi: {
    background: '#060b18',
    borderRadius: '4px',
    padding: '10px 12px',
  } as React.CSSProperties,

  kpiLabel: {
    fontSize: '10px',
    color: '#475569',
    letterSpacing: '0.08em',
    textTransform: 'uppercase' as const,
    marginBottom: '4px',
  } as React.CSSProperties,

  pill: {
    background: '#060b18',
    borderRadius: '4px',
    padding: '8px 10px',
    flex: 1,
    textAlign: 'center' as const,
  } as React.CSSProperties,

  pillLabel: {
    fontSize: '9px',
    color: '#475569',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.08em',
    marginBottom: '3px',
  } as React.CSSProperties,

  pillVal: {
    fontFamily: "'IBM Plex Mono', monospace",
    fontSize: '14px',
    fontWeight: 500,
  } as React.CSSProperties,

  barBg: {
    height: '4px',
    background: '#1e2a4a',
    borderRadius: '2px',
    overflow: 'hidden',
    marginTop: '4px',
  } as React.CSSProperties,

  badgeOn: {
    fontSize: '11px',
    padding: '3px 10px',
    borderRadius: '3px',
    fontWeight: 500,
    letterSpacing: '0.05em',
    background: '#0f2a1a',
    color: '#4ade80',
    border: '1px solid #166534',
  } as React.CSSProperties,

  onlineDot: {
    width: '7px',
    height: '7px',
    borderRadius: '50%',
    background: '#4ade80',
    display: 'inline-block',
    marginRight: '5px',
  } as React.CSSProperties,

  mono: {
    fontFamily: "'IBM Plex Mono', monospace",
  } as React.CSSProperties,
} as const;

// ── Helpers ──────────────────────────────────────────────────────────────────
const getWindColor = (speed: number): string => {
  if (speed > 35) return '#f87171';
  if (speed > 25) return '#fbbf24';
  return '#4ade80';
};

const getRainColor = (rain: number): string => (rain > 5 ? '#f87171' : rain > 0 ? '#fbbf24' : '#4ade80');
const getRainLabel = (rain: number): string => (rain === 0 ? 'None' : `${rain.toFixed(1)} mm/h`);

const getImpact = (a: WeatherData, b: WeatherData) => {
  const maxWind = Math.max(a.wind_speed, b.wind_speed);
  const maxRain = Math.max(a.rain, b.rain);
  const maxHum = Math.max(a.humidity, b.humidity);
  if (maxRain > 5 || maxWind > 35) {
    return {
      impact: 'bad' as const,
      label: 'HIGH',
      msg: 'Rain detected — significant signal attenuation expected. High wind speed risks dish misalignment. Auto-realignment rate will increase.',
      bg: '#1f0a0a', color: '#f87171', border: '#7f1d1d',
    };
  }
  if (maxWind > 20 || maxHum > 80) {
    return {
      impact: 'warn' as const,
      label: 'MODERATE',
      msg: 'Rising humidity may cause mild rain fade. Wind gusts could introduce dish vibration — monitor alignment frequency.',
      bg: '#231a05', color: '#fbbf24', border: '#854f0b',
    };
  }
  return {
    impact: 'good' as const,
    label: 'LOW',
    msg: 'Current conditions are favourable for microwave link operation. Low humidity and no precipitation — beam attenuation is minimal.',
    bg: '#0a2018', color: '#4ade80', border: '#166534',
  };
};

const fmt1 = (n: number) => n.toFixed(1);

// ── Bar fill ─────────────────────────────────────────────────────────────────
const Bar: React.FC<{ pct: number; color: string }> = ({ pct, color }) => (
  <div style={styles.barBg}>
    <div style={{ height: '100%', width: `${Math.min(100, Math.max(0, pct))}%`, background: color, borderRadius: '2px' }} />
  </div>
);

// ── History sample type ───────────────────────────────────────────────────────
interface HistorySample {
  ts: number;
  humidity: number;
  rain: number;
  wind: number;
  signal: number | null; // null when no station has a valid signal yet
}

const MAX_HISTORY_SAMPLES = 288; // ~24h at 5-min cadence

// ── Series config for the multi-line graph ─────────────────────────────────
interface SeriesConfig {
  key: 'humidity' | 'rain' | 'wind' | 'signal';
  label: string;
  color: string;
  unit: string;
  // map raw value -> 0..1 for plotting on a shared axis
  normalize: (v: number) => number;
  format: (v: number) => string;
}

const SERIES: SeriesConfig[] = [
  {
    key: 'humidity',
    label: 'Humidity',
    color: '#60a5fa',
    unit: '%',
    normalize: (v) => Math.max(0, Math.min(100, v)) / 100,
    format: (v) => `${Math.round(v)}%`,
  },
  {
    key: 'rain',
    label: 'Rain',
    color: '#38bdf8',
    unit: 'mm/h',
    // rain rates are typically small; scale 0-20mm/h to 0..1
    normalize: (v) => Math.max(0, Math.min(20, v)) / 20,
    format: (v) => `${v.toFixed(1)}`,
  },
  {
    key: 'wind',
    label: 'Wind',
    color: '#fbbf24',
    unit: 'km/h',
    // scale 0-60 km/h to 0..1
    normalize: (v) => Math.max(0, Math.min(60, v)) / 60,
    format: (v) => `${v.toFixed(1)}`,
  },
  {
    key: 'signal',
    label: 'Avg signal',
    color: '#4ade80',
    unit: 'dBm',
    // signal range -90..0 dBm -> 0..1
    normalize: (v) => Math.max(0, Math.min(90, v + 90)) / 90,
    format: (v) => `${v.toFixed(1)}`,
  },
];

// ── Canvas draw — multi-series, normalized 0..1, against wall-clock time ─────
function drawWeatherGraph(canvas: HTMLCanvasElement, samples: HistorySample[]) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  // ── grid lines (4 horizontal bands) ─────────────────────────────────────
  ctx.strokeStyle = 'rgba(255,255,255,0.04)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = (H / 4) * i;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }

  if (samples.length < 2) return;

  const t0 = samples[0].ts;
  const t1 = samples[samples.length - 1].ts;
  const tRange = t1 - t0 || 1;
  const toX = (ts: number) => ((ts - t0) / tRange) * W;
  const toY = (norm: number) => H - Math.max(0, Math.min(1, norm)) * H;

  for (const series of SERIES) {
    // Build list of points, skipping samples where the value is null (signal)
    const pts: { x: number; y: number }[] = [];
    for (const s of samples) {
      const raw = s[series.key];
      if (raw === null || raw === undefined) continue;
      pts.push({ x: toX(s.ts), y: toY(series.normalize(raw)) });
    }
    if (pts.length < 2) continue;

    ctx.beginPath();
    ctx.strokeStyle = series.color;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    pts.forEach((p, i) => {
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    });
    ctx.stroke();

    // dot at latest point for this series
    const last = pts[pts.length - 1];
    ctx.beginPath();
    ctx.arc(last.x, last.y, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = series.color;
    ctx.fill();
  }
}

function fmtTime(ts: number) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

// ── Props ─────────────────────────────────────────────────────────────────────
interface EnvironmentalPanelProps {
  userLat?: number;
  userLon?: number;
  refreshInterval?: number;
  stationA?: StationLike;
  stationB?: StationLike;
}

// ── Main Component ────────────────────────────────────────────────────────────
const EnvironmentalPanel: React.FC<EnvironmentalPanelProps> = ({
  userLat,
  userLon,
  refreshInterval = REFRESH_INTERVAL_MS,
  stationA,
  stationB,
}) => {
  const [data, setData] = useState<EnvironmentalResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastFetched, setLastFetched] = useState<Date | null>(null);

  // ── Weather/signal history ────────────────────────────────────────────────
  const historyRef = useRef<HistorySample[]>([]);
  const [history, setHistory] = useState<HistorySample[]>([]);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const fetchEnvironmental = useCallback(async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/environmental-data`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lat: userLat ?? null, lon: userLon ?? null }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      const json: EnvironmentalResponse = await res.json();
      setData(json);
      setError(null);
      setLastFetched(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch environmental data');
    } finally {
      setLoading(false);
    }
  }, [userLat, userLon]);

  useEffect(() => {
    fetchEnvironmental();
    const interval = setInterval(fetchEnvironmental, refreshInterval);
    return () => clearInterval(interval);
  }, [fetchEnvironmental, refreshInterval]);

  // ── Append a history sample whenever fresh weather data arrives ──────────
  useEffect(() => {
    if (!data) return;

    const { station_a: a, station_b: b } = data;

    const sigA = stationA?.signal_dbm;
    const sigB = stationB?.signal_dbm;
    const validSigs = [sigA, sigB].filter(
      (v): v is number => typeof v === 'number' && v > -99
    );
    const avgSignal = validSigs.length > 0
      ? validSigs.reduce((sum, v) => sum + v, 0) / validSigs.length
      : null;

    const entry: HistorySample = {
      ts: Date.now(),
      humidity: (a.humidity + b.humidity) / 2,
      rain: Math.max(a.rain, b.rain),
      wind: Math.max(a.wind_speed, b.wind_speed),
      signal: avgSignal,
    };

    historyRef.current = [...historyRef.current, entry].slice(-MAX_HISTORY_SAMPLES);
    setHistory([...historyRef.current]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  // ── Draw the graph ─────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    function syncAndDraw() {
      const parent = canvas!.parentElement;
      const w = (parent?.offsetWidth || 300);
      canvas!.width = w;
      canvas!.height = 90;
      drawWeatherGraph(canvas!, historyRef.current);
    }

    syncAndDraw();

    const ro = new ResizeObserver(syncAndDraw);
    ro.observe(canvas.parentElement ?? canvas);
    return () => ro.disconnect();
  }, [history]);

  // ── Loading ───────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div style={styles.card}>
        <div style={styles.cardTitle}>Environmental</div>
        <div style={{ ...styles.mono, fontSize: '11px', color: '#475569', textAlign: 'center', padding: '20px 0', fontStyle: 'italic' }}>
          Fetching weather data…
        </div>
      </div>
    );
  }

  // ── Error ─────────────────────────────────────────────────────────────────
  if (error || !data) {
    return (
      <div style={styles.card}>
        <div style={styles.cardTitle}>Environmental</div>
        <div style={{ fontSize: '11px', color: '#f87171', textAlign: 'center', padding: '20px 0' }}>
          {error ?? 'No data available'}
          <button
            onClick={fetchEnvironmental}
            style={{ display: 'block', margin: '8px auto 0', fontSize: '10px', color: '#475569', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline', fontFamily: "'Syne', sans-serif" }}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  const { station_a: a, station_b: b, user_location: u } = data;
  const wx = getImpact(a, b);
  const maxWind = Math.max(a.wind_speed, b.wind_speed);

  const firstTs = history.length > 0 ? fmtTime(history[0].ts) : null;
  const lastTs = history.length > 0 ? fmtTime(history[history.length - 1].ts) : null;
  const latest = history.length > 0 ? history[history.length - 1] : null;

  // ── Main render ───────────────────────────────────────────────────────────
  return (
    <div style={{ ...styles.card, border: '1px solid #1e3a5f' }}>

      {/* ── Header ── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          {/* Icon box */}
          <div style={{ width: '28px', height: '28px', borderRadius: '4px', background: '#0c1a3a', border: '1px solid #1d4ed8', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="8" r="3" stroke="#60a5fa" strokeWidth="1.5" />
              <line x1="8" y1="1" x2="8" y2="3" stroke="#60a5fa" strokeWidth="1.5" strokeLinecap="round" />
              <line x1="8" y1="13" x2="8" y2="15" stroke="#60a5fa" strokeWidth="1.5" strokeLinecap="round" />
              <line x1="1" y1="8" x2="3" y2="8" stroke="#60a5fa" strokeWidth="1.5" strokeLinecap="round" />
              <line x1="13" y1="8" x2="15" y2="8" stroke="#60a5fa" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </div>
          <div>
            <div style={{ fontSize: '13px', fontWeight: 700, color: '#e2e8f0', letterSpacing: '0.05em' }}>Weather station</div>
            <div style={{ ...styles.mono, fontSize: '10px', color: '#475569' }}>
              Live · {lastFetched ? lastFetched.toLocaleTimeString() : '—'}
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          {/* Impact badge */}
          <div style={{
            fontSize: '11px', padding: '4px 12px', borderRadius: '3px',
            fontWeight: 700, letterSpacing: '0.06em',
            background: wx.bg, color: wx.color, border: `1px solid ${wx.border}`,
          }}>
            Link impact: {wx.label}
          </div>
          <span style={styles.badgeOn}>
            <span style={styles.onlineDot} />Pi online
          </span>
        </div>
      </div>

      {/* ── Body grid ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '16px', alignItems: 'start' }}>

        {/* Left: temp + conditions */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', background: '#060b18', borderRadius: '6px', padding: '14px 20px', minWidth: '110px' }}>
          <div style={{ fontSize: '10px', color: '#475569', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '6px' }}>Temperature</div>
          <div style={{ ...styles.mono, fontSize: '28px', fontWeight: 500, color: '#e2e8f0', lineHeight: 1 }}>
            {fmt1((a.temperature + b.temperature) / 2)}
          </div>
          <div style={{ ...styles.mono, fontSize: '13px', color: '#64748b' }}>°C</div>

          <div style={{ marginTop: '12px', fontSize: '10px', color: '#475569', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '6px' }}>Conditions</div>
          <div style={{ fontSize: '12px', fontWeight: 700, color: '#60a5fa', textAlign: 'center' }}>
            {wx.impact === 'bad' ? 'Overcast / wet' : wx.impact === 'warn' ? 'Warm / humid' : 'Clear / dry'}
          </div>
        </div>

        {/* Right: pills + impact box */}
        <div>

          {/* Row 1: humidity, pressure, wind, wind dir */}
          <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
            <div style={styles.pill}>
              <div style={styles.pillLabel}>Humidity</div>
              <div style={{ ...styles.pillVal, color: '#60a5fa' }}>
                {Math.round((a.humidity + b.humidity) / 2)}%
              </div>
              <Bar pct={(a.humidity + b.humidity) / 2} color="#2563eb" />
            </div>

            <div style={styles.pill}>
              <div style={styles.pillLabel}>Pressure</div>
              <div style={{ ...styles.pillVal, color: '#94a3b8' }}>
                {Math.round((a.pressure + b.pressure) / 2)} hPa
              </div>
              <Bar pct={((a.pressure + b.pressure) / 2 - 980) / 60 * 100} color="#475569" />
            </div>

            <div style={styles.pill}>
              <div style={styles.pillLabel}>Wind speed</div>
              <div style={{ ...styles.pillVal, color: getWindColor(maxWind) }}>
                {fmt1(maxWind)} km/h
              </div>
              <Bar pct={maxWind * 2} color="#854f0b" />
            </div>

            <div style={styles.pill}>
              <div style={styles.pillLabel}>Wind dir</div>
              <div style={{ ...styles.pillVal, color: '#94a3b8' }}>—</div>
              <div style={{ marginTop: '4px', display: 'flex', justifyContent: 'center' }}>
                <svg width="24" height="24" viewBox="0 0 24 24">
                  <circle cx="12" cy="12" r="10" stroke="#1e2a4a" strokeWidth="1" fill="none" />
                  <polygon points="12,4 9,16 12,13 15,16" fill="#fbbf24" />
                </svg>
              </div>
            </div>
          </div>

          {/* Row 2: rain, dew point, fade risk, multipath */}
          <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
            <div style={styles.pill}>
              <div style={styles.pillLabel}>Rain</div>
              <div style={{ ...styles.pillVal, color: getRainColor(Math.max(a.rain, b.rain)) }}>
                {getRainLabel(Math.max(a.rain, b.rain))}
              </div>
            </div>

            <div style={styles.pill}>
              <div style={styles.pillLabel}>Dew point</div>
              <div style={{ ...styles.pillVal, color: '#94a3b8' }}>
                {fmt1((a.temperature + b.temperature) / 2 - ((100 - (a.humidity + b.humidity) / 2) / 5))}°C
              </div>
            </div>

            <div style={styles.pill}>
              <div style={styles.pillLabel}>Signal fade risk</div>
              <div style={{ ...styles.pillVal, color: wx.impact === 'bad' ? '#f87171' : wx.impact === 'warn' ? '#fbbf24' : '#4ade80' }}>
                {wx.impact === 'bad' ? 'High' : wx.impact === 'warn' ? 'Moderate' : 'Low'}
              </div>
            </div>

            <div style={styles.pill}>
              <div style={styles.pillLabel}>Multipath risk</div>
              <div style={{ ...styles.pillVal, color: wx.impact === 'bad' ? '#f87171' : wx.impact === 'warn' ? '#fbbf24' : '#4ade80' }}>
                {wx.impact === 'bad' ? 'High' : wx.impact === 'warn' ? 'Moderate' : 'Low'}
              </div>
            </div>
          </div>

          {/* Impact message box */}
          <div style={{
            borderLeft: `3px solid ${wx.border}`,
            background: wx.bg,
            color: wx.color,
            padding: '8px 10px',
            fontSize: '11px',
            lineHeight: 1.5,
            borderRadius: '0 3px 3px 0',
          }}>
            {wx.msg}
          </div>
        </div>
      </div>

      {/* ── Station A / B detail KPIs ── */}
      <div style={{ marginTop: '12px', borderTop: '1px solid #1e2a4a', paddingTop: '12px' }}>
        <div style={{ fontSize: '10px', color: '#475569', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '8px' }}>
          Station A / Station B
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px' }}>
          {[
            { label: 'Temperature', valA: `${fmt1(a.temperature)}°C`, valB: `${fmt1(b.temperature)}°C` },
            { label: 'Wind', valA: `${fmt1(a.wind_speed)} km/h`, valB: `${fmt1(b.wind_speed)} km/h` },
            { label: 'Rain', valA: getRainLabel(a.rain), valB: getRainLabel(b.rain) },
            { label: 'Humidity', valA: `${Math.round(a.humidity)}%`, valB: `${Math.round(b.humidity)}%` },
            { label: 'Pressure', valA: `${Math.round(a.pressure)} hPa`, valB: `${Math.round(b.pressure)} hPa` },
          ].map(({ label, valA, valB }) => (
            <div key={label} style={styles.kpi}>
              <div style={styles.kpiLabel}>{label}</div>
              <div style={{ ...styles.mono, fontSize: '12px', color: '#e2e8f0' }}>{valA}</div>
              <div style={{ ...styles.mono, fontSize: '11px', color: '#475569' }}>{valB}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Optional user location ── */}
      {u && (
        <div style={{ marginTop: '12px', borderTop: '1px solid #1e2a4a', paddingTop: '10px' }}>
          <div style={{ fontSize: '10px', color: '#475569', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '8px' }}>
            Your Location
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px' }}>
            {[
              { label: 'Temp', val: `${fmt1(u.temperature)}°C` },
              { label: 'Wind', val: `${fmt1(u.wind_speed)} km/h` },
              { label: 'Rain', val: getRainLabel(u.rain) },
            ].map(({ label, val }) => (
              <div key={label} style={styles.kpi}>
                <div style={styles.kpiLabel}>{label}</div>
                <div style={{ ...styles.mono, fontSize: '14px', color: '#e2e8f0' }}>{val}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Weather vs signal history graph ── */}
      <div style={{ marginTop: '12px', borderTop: '1px solid #1e2a4a', paddingTop: '12px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '5px' }}>
          <div style={{ fontSize: '10px', color: '#475569', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
            Weather vs signal · history
          </div>
          <div style={{ ...styles.mono, fontSize: '10px', color: '#475569' }}>
            {history.length > 0 ? `${history.length} pts` : 'waiting…'}
          </div>
        </div>

        {/* Legend */}
        <div style={{ display: 'flex', gap: '14px', marginBottom: '6px', flexWrap: 'wrap' }}>
          {SERIES.map(s => {
            const val = latest ? latest[s.key] : null;
            return (
              <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '10px', color: '#94a3b8' }}>
                <span style={{ width: '8px', height: '8px', borderRadius: '2px', background: s.color, display: 'inline-block' }} />
                <span>{s.label}</span>
                <span style={{ ...styles.mono, color: '#e2e8f0' }}>
                  {val !== null && val !== undefined ? `${s.format(val)} ${s.unit}` : '—'}
                </span>
              </div>
            );
          })}
        </div>

        <div style={{ position: 'relative', width: '100%', height: '90px' }}>
          <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: '100%', borderRadius: '3px', background: '#060b18' }} />
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '2px' }}>
          <span style={{ ...styles.mono, fontSize: '8px', color: '#1e3a5a' }}>{firstTs ?? '—'}</span>
          <span style={{ ...styles.mono, fontSize: '8px', color: '#1e3a5a' }}>{lastTs ?? '—'}</span>
        </div>
      </div>
    </div>
  );
};

export default EnvironmentalPanel;