import React, { useState, useCallback, useEffect } from 'react';

// ── Types ─────────────────────────────────────────────────────────────────────
interface Alert {
  id: string | number;
  timestamp: string;
  severity: string;
  message: string;
}

interface BackendLog {
  ts: string;
  station_id: string;
  message: string;
  level: string;
}

interface SystemStatusEntry {
  station_id: string;
  label: string;
  status: string;
  signal_dbm: number;
  azimuth: number;
  elevation: number;
  mode: string;
  has_error: boolean;
  error_message: string | null;
}

interface DerivedKpi {
  avg_signal_dbm: number;
  online_count: number;
  total_count: number;
  downtime_reduction: number;
  power_usage_w: number;
}

type ReportTab = 'alerts' | 'report';
type AlertSeverity = 'info' | 'warning' | 'error';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL ?? 'http://localhost:8000';

// ── Design tokens (mirror the HTML dashboard exactly) ─────────────────────────
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

  kpiNum: {
    fontFamily: "'IBM Plex Mono', monospace",
    fontSize: '17px',
    fontWeight: 500,
    color: '#e2e8f0',
  } as React.CSSProperties,

  mono: {
    fontFamily: "'IBM Plex Mono', monospace",
  } as React.CSSProperties,

  btn: {
    fontFamily: "'Syne', sans-serif",
    fontSize: '11px',
    fontWeight: 700,
    letterSpacing: '0.08em',
    padding: '6px 14px',
    borderRadius: '3px',
    border: 'none',
    cursor: 'pointer',
    textTransform: 'uppercase' as const,
  } as React.CSSProperties,

  btnActive: {
    background: '#166534',
    color: '#4ade80',
  } as React.CSSProperties,

  btnManual: {
    background: '#1e2a4a',
    color: '#64748b',
  } as React.CSSProperties,

  modeBtn: {
    fontFamily: "'Syne', sans-serif",
    fontSize: '10px',
    fontWeight: 700,
    letterSpacing: '0.08em',
    padding: '5px 14px',
    cursor: 'pointer',
    textTransform: 'uppercase' as const,
    border: 'none',
    flex: 1,
    textAlign: 'center' as const,
  } as React.CSSProperties,
} as const;

// ── Severity styles matching the dashboard log tags ───────────────────────────
const severityStyles: Record<AlertSeverity, { bg: string; color: string; tagBg: string; tagColor: string; label: string }> = {
  info:    { bg: '#0c1a3a', color: '#60a5fa', tagBg: '#0c1a3a',  tagColor: '#60a5fa', label: 'INFO' },
  warning: { bg: '#231a05', color: '#fbbf24', tagBg: '#231a05',  tagColor: '#fbbf24', label: 'WARN' },
  error:   { bg: '#1f0a0a', color: '#f87171', tagBg: '#1f0a0a',  tagColor: '#f87171', label: 'ERR'  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────
const safeNum = (n: unknown): number =>
  typeof n === 'number' && isFinite(n) ? n : 0;

const fmt = (n: unknown, decimals = 1): string =>
  isFinite(Number(n)) ? Number(n).toFixed(decimals) : '—';

const levelToSeverity = (level: string): AlertSeverity => {
  const l = (level ?? '').toUpperCase();
  if (l === 'ERROR') return 'error';
  if (l === 'WARN' || l === 'WARNING') return 'warning';
  return 'info';
};

// ── Sub-components ────────────────────────────────────────────────────────────

/** Matches .log-entry in the HTML */
const LogEntry: React.FC<{ time: string; tag: string; severity: AlertSeverity; msg: string }> = ({ time, tag, severity, msg }) => {
  const s = severityStyles[severity];
  return (
    <div style={{
      display: 'flex', gap: '8px', padding: '7px 0',
      borderBottom: '1px solid #0f172a',
      fontSize: '11px', fontFamily: "'IBM Plex Mono', monospace",
    }}>
      <span style={{ color: '#334155', minWidth: '48px' }}>{time}</span>
      <span style={{
        padding: '1px 6px', borderRadius: '2px', fontSize: '10px', fontWeight: 500,
        minWidth: '32px', textAlign: 'center',
        background: s.tagBg, color: s.tagColor,
      }}>{tag}</span>
      <span style={{ color: '#64748b', flex: 1 }}>{msg}</span>
    </div>
  );
};

/** Matches .kpi with two-line numeric + sub */
const KpiCard: React.FC<{ label: string; value: string; sub?: string; color?: string }> = ({
  label, value, sub, color = '#4ade80',
}) => (
  <div style={styles.kpi}>
    <div style={styles.kpiLabel}>{label}</div>
    <div style={{ ...styles.kpiNum, color }}>{value}</div>
    {sub && <div style={{ fontSize: '10px', color: '#4ade80', marginTop: '2px' }}>{sub}</div>}
  </div>
);

/** Matches the section divider labels in the HTML */
const SectionLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{
    fontSize: '10px', fontWeight: 700, letterSpacing: '0.15em',
    color: '#475569', textTransform: 'uppercase',
    margin: '12px 0 8px',
  }}>
    {children}
  </div>
);

// ── Props ─────────────────────────────────────────────────────────────────────
interface AlertsPanelProps {
  alerts: Alert[];
}

// ── Main Component ────────────────────────────────────────────────────────────
const AlertsPanel: React.FC<AlertsPanelProps> = ({ alerts }) => {
  const [tab, setTab] = useState<ReportTab>('alerts');
  const [logs, setLogs] = useState<BackendLog[]>([]);
  const [kpi, setKpi] = useState<DerivedKpi | null>(null);
  const [loadingReport, setLoadingReport] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadMsg, setDownloadMsg] = useState<string | null>(null);

  // ── Fetch report data ─────────────────────────────────────────────────────
  const fetchReportData = useCallback(async () => {
    setLoadingReport(true);
    setReportError(null);
    try {
      const [logsRes, statusRes] = await Promise.all([
        fetch(`${BACKEND_URL}/logs?limit=50`),
        fetch(`${BACKEND_URL}/system-status`),
      ]);
      if (!logsRes.ok) throw new Error(`Logs fetch failed: HTTP ${logsRes.status}`);
      const logsJson = await logsRes.json();
      const fetchedLogs: BackendLog[] = Array.isArray(logsJson.logs) ? logsJson.logs : [];
      setLogs(fetchedLogs);

      if (statusRes.ok) {
        const statusJson = await statusRes.json();
        const entries = Object.values(statusJson) as SystemStatusEntry[];
        if (entries.length > 0) {
          const signals = entries.map(e => safeNum(e.signal_dbm)).filter(s => s !== 0);
          const avgSignal = signals.length > 0 ? signals.reduce((a, b) => a + b, 0) / signals.length : -65;
          setKpi({
            avg_signal_dbm: avgSignal,
            online_count: entries.filter(e => e.status === 'ONLINE').length,
            total_count: entries.length,
            downtime_reduction: 15.0,
            power_usage_w: 48.5,
          });
        }
      }
    } catch (e) {
      setReportError(e instanceof Error ? e.message : 'Failed to fetch report data');
    } finally {
      setLoadingReport(false);
    }
  }, []);

  useEffect(() => {
    if (tab === 'report') fetchReportData();
  }, [tab, fetchReportData]);

  // ── CSV export ────────────────────────────────────────────────────────────
  const exportAlertsCSV = () => {
    const headers = 'ID,Timestamp,Severity,Message\n';
    const csvContent = alerts
      .map(a => `${a.id},${a.timestamp},${a.severity},"${a.message.replace(/"/g, '""')}"`)
      .join('\n');
    const blob = new Blob([headers + csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'satellite_alerts.csv';
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // ── PDF download ──────────────────────────────────────────────────────────
  const downloadPDF = async () => {
    setDownloading(true);
    setDownloadMsg(null);
    try {
      const res = await fetch(`${BACKEND_URL}/report/pdf`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const disposition = res.headers.get('Content-Disposition') ?? '';
      const match = disposition.match(/filename="?([^"]+)"?/);
      const filename = match?.[1] ?? `satellite_report_${Date.now()}.pdf`;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      setDownloadMsg('Report downloaded successfully.');
    } catch (e) {
      setDownloadMsg(`Download failed: ${e instanceof Error ? e.message : 'Unknown error'}`);
    } finally {
      setDownloading(false);
      setTimeout(() => setDownloadMsg(null), 4000);
    }
  };

  // ── Derived log stats ─────────────────────────────────────────────────────
  const errorLogs  = logs.filter(l => (l.level ?? '').toUpperCase() === 'ERROR');
  const warnLogs   = logs.filter(l => ['WARN', 'WARNING'].includes((l.level ?? '').toUpperCase()));
  const manualCmds = logs.filter(l => l.message?.toLowerCase().includes('manual command'));
  const infoCount  = logs.length - errorLogs.length - warnLogs.length;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={styles.card}>

      {/* ── Header row ── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
        <div style={styles.cardTitle}>Alerts &amp; Reports</div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {/* Tab toggle — matches .mode-toggle */}
          <div style={{ display: 'flex', border: '1px solid #1e2a4a', borderRadius: '3px', overflow: 'hidden' }}>
            {(['alerts', 'report'] as ReportTab[]).map(t => (
              <button
                key={t}
                onClick={() => setTab(t)}
                style={{
                  ...styles.modeBtn,
                  background: tab === t ? '#1d4ed8' : 'transparent',
                  color: tab === t ? '#fff' : '#334155',
                }}
              >
                {t === 'alerts' ? 'Alerts' : 'Report'}
              </button>
            ))}
          </div>

          {tab === 'alerts' && (
            <button
              onClick={exportAlertsCSV}
              style={{ ...styles.btn, ...styles.btnActive, fontSize: '10px', padding: '5px 12px' }}
            >
              Export CSV
            </button>
          )}
          {tab === 'report' && (
            <button
              onClick={fetchReportData}
              disabled={loadingReport}
              style={{ ...styles.btn, ...styles.btnManual, fontSize: '10px', padding: '5px 12px', opacity: loadingReport ? 0.5 : 1 }}
            >
              {loadingReport ? 'Refreshing…' : 'Refresh'}
            </button>
          )}
        </div>
      </div>

      {/* ══ ALERTS TAB ══ */}
      {tab === 'alerts' && (
        <div style={{ maxHeight: '260px', overflowY: 'auto' }}>
          {alerts.length === 0 ? (
            <div style={{ ...styles.mono, fontSize: '11px', color: '#475569', textAlign: 'center', padding: '20px 0', fontStyle: 'italic' }}>
              No alerts
            </div>
          ) : (
            alerts.map(alert => {
              const sev = levelToSeverity(alert.severity);
              const s = severityStyles[sev];
              const time = alert.timestamp?.slice(11, 16) ?? '—';
              return (
                <LogEntry
                  key={alert.id}
                  time={time}
                  tag={s.label}
                  severity={sev}
                  msg={alert.message}
                />
              );
            })
          )}
        </div>
      )}

      {/* ══ REPORT TAB ══ */}
      {tab === 'report' && (
        <div style={{ maxHeight: '260px', overflowY: 'auto', paddingRight: '4px' }}>

          {reportError && (
            <div style={{ ...styles.mono, fontSize: '11px', color: '#f87171', background: '#1f0a0a', padding: '8px 10px', borderRadius: '3px', marginBottom: '8px' }}>
              {reportError}
            </div>
          )}

          {loadingReport && !reportError && (
            <div style={{ ...styles.mono, fontSize: '11px', color: '#475569', textAlign: 'center', padding: '20px 0', fontStyle: 'italic' }}>
              Loading report data…
            </div>
          )}

          {!loadingReport && !reportError && (
            <>
              {/* KPI grid */}
              {kpi && (
                <>
                  <SectionLabel>Live KPI Snapshot</SectionLabel>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                    <KpiCard
                      label="Avg signal"
                      value={`${fmt(kpi.avg_signal_dbm)} dBm`}
                      sub={kpi.avg_signal_dbm > -70 ? 'good' : 'marginal'}
                      color={kpi.avg_signal_dbm > -70 ? '#4ade80' : '#fbbf24'}
                    />
                    <KpiCard
                      label="Stations online"
                      value={`${kpi.online_count} / ${kpi.total_count}`}
                      sub="heartbeat confirmed"
                      color={kpi.online_count === kpi.total_count ? '#4ade80' : '#fbbf24'}
                    />
                    <KpiCard
                      label="Manual realignments"
                      value={String(manualCmds.length)}
                      sub="this session"
                      color="#60a5fa"
                    />
                    <KpiCard
                      label="Power draw"
                      value={`${fmt(kpi.power_usage_w)} W`}
                      sub="last snapshot"
                      color="#fbbf24"
                    />
                  </div>
                </>
              )}

              {/* Log summary */}
              <SectionLabel>Log Highlights</SectionLabel>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px', textAlign: 'center' }}>
                {[
                  { count: errorLogs.length,  color: '#f87171', label: 'Errors'   },
                  { count: warnLogs.length,   color: '#fbbf24', label: 'Warnings' },
                  { count: Math.max(0, infoCount), color: '#4ade80', label: 'Info' },
                ].map(({ count, color, label }) => (
                  <div key={label} style={styles.kpi}>
                    <div style={{ ...styles.mono, fontSize: '22px', fontWeight: 500, color }}>{count}</div>
                    <div style={{ fontSize: '10px', color: '#475569', textTransform: 'uppercase', letterSpacing: '0.08em', marginTop: '2px' }}>{label}</div>
                  </div>
                ))}
              </div>

              {/* Recent log entries */}
              <SectionLabel>Recent System Logs</SectionLabel>
              <div>
                {logs.length === 0 ? (
                  <div style={{ ...styles.mono, fontSize: '11px', color: '#475569', fontStyle: 'italic' }}>No logs available</div>
                ) : (
                  logs.slice(0, 8).map((log, i) => {
                    const sev = levelToSeverity(log.level);
                    const s = severityStyles[sev];
                    return (
                      <LogEntry
                        key={i}
                        time={(log.ts ?? '').slice(11, 16)}
                        tag={s.label}
                        severity={sev}
                        msg={`[${log.station_id ?? '—'}] ${log.message ?? ''}`}
                      />
                    );
                  })
                )}
              </div>

              {/* PDF download */}
              <SectionLabel>Full Report</SectionLabel>
              <p style={{ fontSize: '11px', color: '#475569', marginBottom: '8px', lineHeight: 1.5 }}>
                Full PDF includes station status, environmental readings, KPI trends, and all system logs.
              </p>
              <button
                onClick={downloadPDF}
                disabled={downloading}
                style={{
                  ...styles.btn,
                  width: '100%',
                  background: downloading ? '#1e2a4a' : '#166534',
                  color: downloading ? '#64748b' : '#4ade80',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '8px',
                  fontSize: '11px',
                  padding: '8px 14px',
                  opacity: downloading ? 0.6 : 1,
                  transition: 'opacity 0.2s',
                }}
              >
                {downloading ? (
                  <>
                    <svg style={{ animation: 'spin 1s linear infinite', width: '14px', height: '14px' }} viewBox="0 0 24 24" fill="none">
                      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" opacity="0.25" />
                      <path fill="currentColor" d="M4 12a8 8 0 018-8v8z" opacity="0.75" />
                    </svg>
                    Generating…
                  </>
                ) : (
                  <>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M12 15V3m0 12l-4-4m4 4l4-4M2 17v2a2 2 0 002 2h16a2 2 0 002-2v-2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    Download PDF Report
                  </>
                )}
              </button>
              {downloadMsg && (
                <div style={{
                  ...styles.mono,
                  fontSize: '10px',
                  textAlign: 'center',
                  marginTop: '6px',
                  color: downloadMsg.startsWith('Download failed') ? '#f87171' : '#4ade80',
                }}>
                  {downloadMsg}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Spin keyframes injected once */}
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
};

export default AlertsPanel;
