// SignalHistoryChart.tsx
import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  Chart,
  LineElement, PointElement, LineController,
  CategoryScale, LinearScale,
  Tooltip, Filler,
} from 'chart';

Chart.register(LineElement, PointElement, LineController, CategoryScale, LinearScale, Tooltip, Filler);

const BASE_URL = 'http://10.58.32.23:8000';
const LIMIT = 40;
const POLL_MS = 5000;

interface SignalRecord {
  ts: string;
  signal_dbm: number;
}

async function fetchLog(stationId: string): Promise<SignalRecord[]> {
  const res = await fetch(`${BASE_URL}/dashboard/position_signal_log/${stationId}?limit=${LIMIT}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return (data.records ?? [])
    .slice()
    .reverse()
    .filter((r: SignalRecord) => r.signal_dbm > -99);
}

function alignByTime(recs1: SignalRecord[], recs2: SignalRecord[]) {
  const all = [...recs1.map(r => r.ts), ...recs2.map(r => r.ts)];
  const uniq = [...new Set(all)].sort();
  const map1 = Object.fromEntries(recs1.map(r => [r.ts, r.signal_dbm]));
  const map2 = Object.fromEntries(recs2.map(r => [r.ts, r.signal_dbm]));
  return {
    labels: uniq.map(t => t.slice(11, 19)),
    d1: uniq.map(t => map1[t] ?? null),
    d2: uniq.map(t => map2[t] ?? null),
  };
}

const SignalHistoryChart: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef  = useRef<Chart | null>(null);
  const [error, setError] = useState<string | null>(null);

  const draw = useCallback(async () => {
    try {
      const [recs1, recs2] = await Promise.all([
        fetchLog('station_1'),
        fetchLog('station_2'),
      ]);
      const { labels, d1, d2 } = alignByTime(recs1, recs2);

      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d')!;

      if (chartRef.current) {
        chartRef.current.data.labels = labels;
        chartRef.current.data.datasets[0].data = d1;
        chartRef.current.data.datasets[1].data = d2;
        chartRef.current.update('none');
      } else {
        chartRef.current = new Chart(ctx, {
          type: 'line',
          data: {
            labels,
            datasets: [
              {
                label: 'Station 1',
                data: d1,
                borderColor: '#2563eb',
                backgroundColor: 'rgba(37,99,235,0.06)',
                borderWidth: 1.5,
                pointRadius: 0,
                tension: 0.3,
                fill: true,
                spanGaps: true,
              },
              {
                label: 'Station 2',
                data: d2,
                borderColor: '#16a34a',
                backgroundColor: 'rgba(22,163,74,0.05)',
                borderWidth: 1.5,
                pointRadius: 0,
                tension: 0.3,
                fill: true,
                spanGaps: true,
                borderDash: [5, 4],
              },
            ],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
              legend: { display: false },
              tooltip: {
                callbacks: {
                  label: ctx =>
                    `${ctx.dataset.label}: ${
                      ctx.parsed.y !== null ? ctx.parsed.y.toFixed(1) + ' dBm' : 'N/A'
                    }`,
                },
              },
            },
            scales: {
              x: {
                ticks: { maxTicksLimit: 8, color: '#64748b', font: { size: 10 } },
                grid: { color: 'rgba(100,116,139,0.08)' },
              },
              y: {
                min: -80,
                max: -30,
                ticks: {
                  color: '#64748b',
                  font: { size: 10 },
                  callback: v => `${v} dBm`,
                  stepSize: 10,
                },
                grid: { color: 'rgba(100,116,139,0.08)' },
              },
            },
          },
        });
      }
      setError(null);
    } catch (e: any) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    draw();
    const id = setInterval(draw, POLL_MS);
    return () => {
      clearInterval(id);
      chartRef.current?.destroy();
      chartRef.current = null;
    };
  }, [draw]);

  return (
    <div className="ma-card" style={{ marginTop: 16 }}>
      {/* header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <span style={{ fontFamily: "'Syne', sans-serif", fontSize: 12, fontWeight: 700,
                       letterSpacing: '0.07em', textTransform: 'uppercase', color: '#64748b' }}>
          Signal history — all stations
        </span>
        <div style={{ display: 'flex', gap: 14, fontSize: 11, color: '#64748b', fontFamily: "'Syne', sans-serif" }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 20, height: 2, background: '#2563eb', display: 'inline-block', borderRadius: 1 }} />
            Station 1
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            {/* dashed indicator */}
            <span style={{ width: 20, height: 0, borderTop: '2px dashed #16a34a', display: 'inline-block' }} />
            Station 2
          </span>
        </div>
      </div>

      {error && (
        <div style={{ fontSize: 11, color: '#f87171', marginBottom: 8 }}>
          Could not reach backend: {error}
        </div>
      )}

      <div style={{ position: 'relative', width: '100%', height: 160 }}>
        <canvas ref={canvasRef} />
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4,
                    fontSize: 9, color: '#1e2a4a', fontFamily: "'IBM Plex Mono', monospace" }}>
        <span>← older</span>
        <span>newer →</span>
      </div>
    </div>
  );
};

export default SignalHistoryChart;