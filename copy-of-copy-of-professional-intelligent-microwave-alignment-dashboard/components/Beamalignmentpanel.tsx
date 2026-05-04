import React, { useEffect, useRef } from 'react';

interface BeamAlignmentPanelProps {
  azimuthA?: number;
  elevationA?: number;
  azimuthB?: number;
  elevationB?: number;
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

const BeamAlignmentPanel: React.FC<BeamAlignmentPanelProps> = ({
  azimuthA = 42,
  elevationA = 18.5,
  azimuthB = 138,
  elevationB = 17,
}) => {
  const beamRef = useRef<HTMLCanvasElement>(null);

  const drawBeam = () => {
    const c = beamRef.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const w = c.width;
    const h = c.height;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#060b18';
    ctx.fillRect(0, 0, w, h);

    const ax = 55, ay = h / 2, bx = 205, by = h / 2;
    const beamLen = 75;

    const drawDish = (cx: number, cy: number, angle: number, col: string) => {
      ctx.strokeStyle = col;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(angle) * beamLen, cy - Math.sin(angle) * beamLen);
      ctx.stroke();

      ctx.globalAlpha = 0.2;
      ctx.strokeStyle = col;
      ctx.lineWidth = 1;
      [-15, -8, 8, 15].forEach(off => {
        const a2 = angle + (off * Math.PI) / 180;
        const l2 = beamLen * (1 - Math.abs(off) / 35);
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(a2) * l2, cy - Math.sin(a2) * l2);
        ctx.stroke();
      });
      ctx.globalAlpha = 1;

      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(cx, cy, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#0a0e1a';
      ctx.beginPath();
      ctx.arc(cx, cy, 4, 0, Math.PI * 2);
      ctx.fill();
    };

    // Link line
    ctx.strokeStyle = 'rgba(74,222,128,0.2)';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 4]);
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
    ctx.setLineDash([]);

    drawDish(ax, ay, (azimuthA * Math.PI) / 180, '#2563eb');
    drawDish(bx, by, Math.PI - (azimuthA * Math.PI) / 180, '#16a34a');

    ctx.fillStyle = '#334155';
    ctx.font = '10px IBM Plex Mono, monospace';
    ctx.fillText('A', ax - 4, ay + 20);
    ctx.fillText('B', bx - 4, by + 20);
  };

  useEffect(() => {
    drawBeam();
  }, [azimuthA, azimuthB]);

  const gaugeStyle = (pct: number): React.CSSProperties => ({
    height: '100%',
    width: `${pct}%`,
    background: '#2563eb',
    borderRadius: '2px',
  });

  return (
    <div style={styles.card}>
      <div style={styles.cardTitle}>Beam Alignment View</div>

      <canvas
        ref={beamRef}
        width={260}
        height={160}
        style={{ display: 'block', margin: '0 auto', borderRadius: '4px' }}
      />

      {/* Legend */}
      <div style={{ display: 'flex', justifyContent: 'center', gap: '20px', marginTop: '8px', marginBottom: '14px' }}>
        {[
          { color: '#2563eb', label: 'Station A' },
          { color: '#16a34a', label: 'Station B' },
        ].map(({ color, label }) => (
          <div key={label} style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '10px', color: '#64748b' }}>
            <div style={{ width: '10px', height: '3px', background: color, borderRadius: '1px' }} />
            {label}
          </div>
        ))}
      </div>

      {/* Angle readouts */}
      {[
        { name: 'Station A', az: azimuthA, el: elevationA },
        { name: 'Station B', az: azimuthB, el: elevationB },
      ].map(({ name, az, el }) => (
        <div key={name} style={{ marginBottom: '10px' }}>
          <div style={{ fontSize: '10px', color: '#475569', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '6px' }}>
            {name}
          </div>
          <div style={{ display: 'flex', gap: '12px' }}>
            {[
              { label: 'Azimuth', val: az, pct: (az / 360) * 100 },
              { label: 'Elevation', val: el, pct: (el / 90) * 100 },
            ].map(({ label, val, pct }) => (
              <div key={label} style={{ flex: 1, textAlign: 'center' }}>
                <div style={{ fontSize: '9px', color: '#64748b', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '4px' }}>
                  {label}
                </div>
                <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: '16px', fontWeight: 500, color: '#60a5fa', marginBottom: '4px' }}>
                  {val.toFixed(1)}°
                </div>
                <div style={{ height: '5px', background: '#1e2a4a', borderRadius: '2px', overflow: 'hidden' }}>
                  <div style={gaugeStyle(pct)} />
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
};

export default BeamAlignmentPanel;