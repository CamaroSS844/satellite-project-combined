import React, { useEffect, useRef } from 'react';

interface PolarRadiationPanelProps {
  /** Label shown below the canvas */
  stationLabel?: string;
  /** Optional custom pattern: array of [angleDeg, magnitude 0..1] */
  pattern?: [number, number][];
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
};

const DEFAULT_PATTERN: [number, number][] = [
  [0, 1], [22.5, 0.87], [45, 0.62], [67.5, 0.28],
  [90, 0.15], [112.5, 0.22], [135, 0.55], [157.5, 0.82],
  [180, 0.95], [202.5, 0.82], [225, 0.55], [247.5, 0.22],
  [270, 0.15], [292.5, 0.28], [315, 0.62], [337.5, 0.87], [360, 1],
];

const PolarRadiationPanel: React.FC<PolarRadiationPanelProps> = ({
  stationLabel = 'Measured beam — dish A',
  pattern = DEFAULT_PATTERN,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const drawPolar = () => {
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

    // Cardinal labels
    ctx.textAlign = 'center';
    ctx.font = '10px Syne, sans-serif';
    [['N', 0], ['E', 90], ['S', 180], ['W', 270]].forEach(([d, angle]) => {
      const rad = ((angle as number) - 90) * (Math.PI / 180);
      ctx.fillStyle = '#475569';
      ctx.fillText(d as string, cx + Math.cos(rad) * (maxR + 12), cy + Math.sin(rad) * (maxR + 12) + 4);
    });
  };

  useEffect(() => {
    drawPolar();
  }, [pattern]);

  // Derived stats from pattern
  const mainLobeMax = Math.max(...pattern.map(([, m]) => m));
  const sidelobeMax = pattern
    .filter(([deg]) => deg > 30 && deg < 330)
    .reduce((max, [, m]) => Math.max(max, m), 0);
  const beamwidthDeg = pattern.filter(([, m]) => m >= 0.707).length * (360 / pattern.length);

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
        fontFamily: "'IBM Plex Mono', monospace", marginTop: '6px', marginBottom: '12px',
      }}>
        {stationLabel}
      </div>

      {/* Stats row */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '6px' }}>
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
        Pattern nominal — front-to-back ratio {((mainLobeMax / Math.max(sidelobeMax, 0.01)) * 10).toFixed(1)} dB
      </div>
    </div>
  );
};

export default PolarRadiationPanel;