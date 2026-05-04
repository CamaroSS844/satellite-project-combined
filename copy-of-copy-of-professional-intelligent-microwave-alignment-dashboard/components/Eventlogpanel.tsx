import React, { useState, useCallback } from 'react';

// ── Types ─────────────────────────────────────────────────────────────────────
type LogLevel = 'ok' | 'info' | 'warn' | 'err';

interface LogEntry {
  id: string | number;
  time: string;
  level: LogLevel;
  message: string;
}

// ── Design tokens ─────────────────────────────────────────────────────────────
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
  btn: {
    fontFamily: "'Syne', sans-serif",
    fontSize: '10px',
    fontWeight: 700,
    letterSpacing: '0.08em',
    padding: '5px 12px',
    borderRadius: '3px',
    border: 'none',
    cursor: 'pointer',
    textTransform: 'uppercase' as const,
  } as React.CSSProperties,
};

const levelMeta: Record<LogLevel, { tagBg: string; tagColor: string; label: string }> = {
  ok:   { tagBg: '#0a2018', tagColor: '#4ade80',  label: 'OK'   },
  info: { tagBg: '#0c1a3a', tagColor: '#60a5fa',  label: 'INFO' },
  warn: { tagBg: '#231a05', tagColor: '#fbbf24',  label: 'WARN' },
  err:  { tagBg: '#1f0a0a', tagColor: '#f87171',  label: 'ERR'  },
};

const SIMULATED_EVENTS: { level: LogLevel; message: string }[] = [
  { level: 'warn', message: 'Wind gust 26 km/h — monitoring dish stability' },
  { level: 'ok',   message: 'Weather Pi — conditions unchanged, link stable' },
  { level: 'info', message: 'Humidity crossed 70% — fade risk elevated to moderate' },
  { level: 'ok',   message: 'Alignment converged after weather-triggered re-sweep' },
  { level: 'err',  message: 'Rain detected — auto-realignment rate increased' },
  { level: 'info', message: 'Station B heartbeat — mem 186KB free' },
  { level: 'warn', message: 'RSSI dropped to -61 dBm — realignment triggered' },
];

// ── Default log entries (mirrors the HTML dashboard) ─────────────────────────
const DEFAULT_ENTRIES: LogEntry[] = [
  { id: 1, time: '02:14', level: 'ok',   message: 'Weather Pi — humidity stable at 58%, no rain' },
  { id: 2, time: '02:12', level: 'ok',   message: 'Auto-alignment converged — Station A → 42.0° / 18.5°' },
  { id: 3, time: '02:09', level: 'warn', message: 'RSSI dropped to -61 dBm — realignment triggered' },
  { id: 4, time: '02:08', level: 'warn', message: 'Wind gust 28 km/h — dish vibration detected' },
  { id: 5, time: '01:55', level: 'info', message: 'Station B heartbeat — mem 186KB free' },
  { id: 6, time: '00:01', level: 'ok',   message: 'System initialised — all services running' },
];

// ── Sub-component: single log row ─────────────────────────────────────────────
const LogRow: React.FC<{ entry: LogEntry; fresh?: boolean }> = ({ entry, fresh }) => {
  const meta = levelMeta[entry.level];
  return (
    <div style={{
      display: 'flex', gap: '8px', padding: '7px 0',
      borderBottom: '1px solid #0f172a',
      fontSize: '11px', fontFamily: "'IBM Plex Mono', monospace",
      opacity: 1,
      transition: fresh ? 'opacity 0.3s ease' : undefined,
    }}>
      <span style={{ color: '#334155', minWidth: '48px' }}>{entry.time}</span>
      <span style={{
        padding: '1px 6px', borderRadius: '2px', fontSize: '10px', fontWeight: 500,
        minWidth: '32px', textAlign: 'center',
        background: meta.tagBg, color: meta.tagColor,
      }}>
        {meta.label}
      </span>
      <span style={{ color: '#64748b', flex: 1 }}>{entry.message}</span>
    </div>
  );
};

// ── Props ─────────────────────────────────────────────────────────────────────
interface EventLogPanelProps {
  /** External log entries to display; falls back to built-in defaults */
  entries?: LogEntry[];
  /** Max entries shown before scrolling */
  maxVisible?: number;
}

// ── Main Component ────────────────────────────────────────────────────────────
const EventLogPanel: React.FC<EventLogPanelProps> = ({
  entries: externalEntries,
  maxVisible = 8,
}) => {
  const [internalEntries, setInternalEntries] = useState<LogEntry[]>(DEFAULT_ENTRIES);
  const [simTick, setSimTick] = useState(0);
  const [freshId, setFreshId] = useState<string | number | null>(null);
  const [filter, setFilter] = useState<LogLevel | 'all'>('all');

  const entries = externalEntries ?? internalEntries;

  // ── CSV export ───────────────────────────────────────────────────────────
  const exportCSV = useCallback(() => {
    const header = 'Time,Level,Message\n';
    const rows = entries.map(e => `${e.time},${e.level.toUpperCase()},"${e.message.replace(/"/g, '""')}"`).join('\n');
    const blob = new Blob([header + rows], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `event_log_${Date.now()}.csv`;
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }, [entries]);

  // ── Simulate event ───────────────────────────────────────────────────────
  const simulateEvent = useCallback(() => {
    const ev = SIMULATED_EVENTS[simTick % SIMULATED_EVENTS.length];
    const now = new Date();
    const t = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
    const newId = Date.now();
    const newEntry: LogEntry = { id: newId, time: t, level: ev.level, message: ev.message };
    setInternalEntries(prev => [newEntry, ...prev].slice(0, maxVisible + 4));
    setFreshId(newId);
    setSimTick(t => t + 1);
    setTimeout(() => setFreshId(null), 600);
  }, [simTick, maxVisible]);

  // ── Filtered entries ─────────────────────────────────────────────────────
  const visible = (filter === 'all' ? entries : entries.filter(e => e.level === filter)).slice(0, maxVisible);

  // ── Level counts for filter badges ───────────────────────────────────────
  const counts: Record<LogLevel | 'all', number> = {
    all:  entries.length,
    ok:   entries.filter(e => e.level === 'ok').length,
    info: entries.filter(e => e.level === 'info').length,
    warn: entries.filter(e => e.level === 'warn').length,
    err:  entries.filter(e => e.level === 'err').length,
  };

  const filterOptions: { key: LogLevel | 'all'; label: string; color: string }[] = [
    { key: 'all',  label: 'All',  color: '#94a3b8' },
    { key: 'ok',   label: 'OK',   color: '#4ade80' },
    { key: 'info', label: 'Info', color: '#60a5fa' },
    { key: 'warn', label: 'Warn', color: '#fbbf24' },
    { key: 'err',  label: 'Err',  color: '#f87171' },
  ];

  return (
    <div style={styles.card}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
        <div style={styles.cardTitle}>Event Log</div>
        <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: '10px', color: '#334155' }}>
          {entries.length} entries
        </div>
      </div>

      {/* Filter strip */}
      <div style={{ display: 'flex', gap: '4px', marginBottom: '10px', flexWrap: 'wrap' }}>
        {filterOptions.map(({ key, label, color }) => (
          <button
            key={key}
            onClick={() => setFilter(key)}
            style={{
              ...styles.btn,
              padding: '3px 9px',
              fontSize: '9px',
              background: filter === key ? '#1e2a4a' : 'transparent',
              color: filter === key ? color : '#475569',
              border: `1px solid ${filter === key ? color + '55' : '#1e2a4a'}`,
              display: 'flex', alignItems: 'center', gap: '4px',
            }}
          >
            {label}
            <span style={{
              fontFamily: "'IBM Plex Mono', monospace",
              background: '#0f172a',
              borderRadius: '2px',
              padding: '0 4px',
              color: filter === key ? color : '#334155',
            }}>
              {counts[key]}
            </span>
          </button>
        ))}
      </div>

      {/* Log rows */}
      <div style={{ maxHeight: '220px', overflowY: 'auto' }}>
        {visible.length === 0 ? (
          <div style={{
            fontFamily: "'IBM Plex Mono', monospace", fontSize: '11px',
            color: '#475569', textAlign: 'center', padding: '20px 0', fontStyle: 'italic',
          }}>
            No entries
          </div>
        ) : (
          visible.map(entry => (
            <LogRow key={entry.id} entry={entry} fresh={entry.id === freshId} />
          ))
        )}
      </div>

      {/* Actions */}
      <div style={{ marginTop: '10px', display: 'flex', gap: '8px' }}>
        <button
          onClick={exportCSV}
          style={{ ...styles.btn, background: '#166534', color: '#4ade80' }}
        >
          Export CSV
        </button>
        <button
          onClick={simulateEvent}
          style={{ ...styles.btn, background: '#1e2a4a', color: '#64748b' }}
        >
          Simulate event
        </button>
      </div>

    </div>
  );
};

export default EventLogPanel;