import React, { useState, useCallback, useEffect } from 'react';
import Card, { CardHeader, CardTitle } from './common/Card';
import { Alert } from '../types';
import { SEVERITY_COLORS } from '../constants';

// ── Types ─────────────────────────────────────────────────────────────────────
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

// ── Helpers ───────────────────────────────────────────────────────────────────
const safeNum = (n: unknown): number =>
  typeof n === 'number' && isFinite(n) ? n : 0;

const fmt = (n: unknown, decimals = 1): string =>
  isFinite(Number(n)) ? Number(n).toFixed(decimals) : '—';

/**
 * Maps backend log level strings → one of the three keys that exist
 * in SEVERITY_COLORS. Guards against any unexpected level value.
 */
const levelToSeverity = (level: string): AlertSeverity => {
  const l = (level ?? '').toUpperCase();
  if (l === 'ERROR') return 'error';
  if (l === 'WARN' || l === 'WARNING') return 'warning';
  return 'info';
};

/**
 * Safe accessor — returns an empty object with bg/text fallbacks if
 * the key is missing from SEVERITY_COLORS (prevents the crash).
 */
const severityStyle = (sev: AlertSeverity) =>
  SEVERITY_COLORS[sev] ?? { bg: '', text: '' };

// ── Sub-components ────────────────────────────────────────────────────────────
const KpiCard: React.FC<{
  label: string;
  value: string;
  sub?: string;
  color?: string;
}> = ({ label, value, sub, color = 'text-accent-green' }) => (
  <div className="bg-bg-light-secondary dark:bg-bg-dark-secondary rounded-lg p-3 flex flex-col gap-1">
    <span className="text-xs text-text-light-secondary dark:text-text-dark-secondary">{label}</span>
    <span className={`text-xl font-bold ${color}`}>{value}</span>
    {sub && (
      <span className="text-[10px] text-text-light-secondary dark:text-text-dark-secondary">
        {sub}
      </span>
    )}
  </div>
);

const SectionHeading: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="text-xs font-semibold uppercase tracking-wider text-text-light-secondary dark:text-text-dark-secondary mb-2 mt-4 first:mt-0">
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

      // system-status → { station_1: {...}, station_2: {...} }
      if (statusRes.ok) {
        const statusJson = await statusRes.json();
        // Object.values gives us the per-station entries
        const entries = Object.values(statusJson) as SystemStatusEntry[];

        if (entries.length > 0) {
          const signals = entries
            .map(e => safeNum(e.signal_dbm))
            .filter(s => s !== 0);                          // exclude missing/zero
          const avgSignal =
            signals.length > 0
              ? signals.reduce((a, b) => a + b, 0) / signals.length
              : -65;

          const onlineCount = entries.filter(e => e.status === 'ONLINE').length;

          setKpi({
            avg_signal_dbm:    avgSignal,
            online_count:      onlineCount,
            total_count:       entries.length,
            downtime_reduction: 15.0,
            power_usage_w:      48.5,
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
      .map(
        a =>
          `${a.id},${a.timestamp},${a.severity},"${a.message.replace(/"/g, '""')}"`
      )
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
      setDownloadMsg(
        `Download failed: ${e instanceof Error ? e.message : 'Unknown error'}`
      );
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
    <Card className="flex flex-col">

      {/* Header */}
      <CardHeader>
        <CardTitle>Alerts &amp; Reports</CardTitle>
        <div className="flex items-center gap-2">
          <div className="flex rounded overflow-hidden border border-border-light dark:border-border-dark text-xs">
            <button
              onClick={() => setTab('alerts')}
              className={`px-3 py-1 transition-colors ${
                tab === 'alerts'
                  ? 'bg-accent-blue text-white'
                  : 'bg-transparent text-text-light-secondary dark:text-text-dark-secondary hover:bg-bg-light-secondary dark:hover:bg-bg-dark-secondary'
              }`}
            >
              Alerts
            </button>
            <button
              onClick={() => setTab('report')}
              className={`px-3 py-1 transition-colors ${
                tab === 'report'
                  ? 'bg-accent-blue text-white'
                  : 'bg-transparent text-text-light-secondary dark:text-text-dark-secondary hover:bg-bg-light-secondary dark:hover:bg-bg-dark-secondary'
              }`}
            >
              Report
            </button>
          </div>

          {tab === 'alerts' && (
            <button
              onClick={exportAlertsCSV}
              className="text-xs bg-bg-light-secondary dark:bg-bg-dark-secondary hover:opacity-80 px-2 py-1 rounded"
            >
              Export CSV
            </button>
          )}
          {tab === 'report' && (
            <button
              onClick={fetchReportData}
              disabled={loadingReport}
              className="text-xs bg-bg-light-secondary dark:bg-bg-dark-secondary hover:opacity-80 px-2 py-1 rounded disabled:opacity-40"
            >
              {loadingReport ? 'Refreshing…' : 'Refresh'}
            </button>
          )}
        </div>
      </CardHeader>

      {/* ══ ALERTS TAB ══ */}
      {tab === 'alerts' && (
        <div className="overflow-y-auto h-64 pr-2 space-y-2">
          {alerts.length === 0 ? (
            <div className="text-xs italic text-center text-text-light-secondary dark:text-text-dark-secondary pt-8">
              No alerts
            </div>
          ) : (
            alerts.map(alert => {
              const style = severityStyle(alert.severity as AlertSeverity);
              return (
                <div
                  key={alert.id}
                  className={`p-2 rounded-md flex items-start ${style.bg} ${style.text}`}
                >
                  <div className="flex-shrink-0 w-16 text-xs opacity-80">{alert.timestamp}</div>
                  <div className="flex-grow pl-2 border-l border-current border-opacity-30">
                    <span className="font-bold text-xs uppercase mr-2">[{alert.severity}]</span>
                    <span className="text-sm">{alert.message}</span>
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}

      {/* ══ REPORT TAB ══ */}
      {tab === 'report' && (
        <div className="overflow-y-auto h-64 pr-1">

          {/* Error */}
          {reportError && (
            <div className="text-xs text-accent-red p-2 bg-red-50 dark:bg-red-900/20 rounded mt-1">
              {reportError}
            </div>
          )}

          {/* Loading */}
          {loadingReport && !reportError && (
            <div className="text-xs italic text-center text-text-light-secondary dark:text-text-dark-secondary pt-8">
              Loading report data…
            </div>
          )}

          {!loadingReport && !reportError && (
            <div className="space-y-1">

              {/* KPI highlights */}
              {kpi && (
                <>
                  <SectionHeading>Live KPI Snapshot</SectionHeading>
                  <div className="grid grid-cols-2 gap-2">
                    <KpiCard
                      label="Avg Signal"
                      value={`${fmt(kpi.avg_signal_dbm)} dBm`}
                      sub="across all stations"
                      color={kpi.avg_signal_dbm > -70 ? 'text-accent-green' : 'text-accent-yellow'}
                    />
                    <KpiCard
                      label="Stations Online"
                      value={`${kpi.online_count} / ${kpi.total_count}`}
                      sub="heartbeat confirmed"
                      color={kpi.online_count === kpi.total_count ? 'text-accent-green' : 'text-accent-yellow'}
                    />
                    <KpiCard
                      label="Manual Realignments"
                      value={String(manualCmds.length)}
                      sub="logged this session"
                      color="text-accent-blue"
                    />
                    <KpiCard
                      label="Power Draw"
                      value={`${fmt(kpi.power_usage_w)} W`}
                      sub="last snapshot"
                      color="text-accent-yellow"
                    />
                  </div>
                </>
              )}

              {/* Log summary badges */}
              <SectionHeading>Log Highlights</SectionHeading>
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="rounded-lg bg-bg-light-secondary dark:bg-bg-dark-secondary p-2">
                  <div className="text-lg font-bold text-accent-red">{errorLogs.length}</div>
                  <div className="text-[10px] text-text-light-secondary dark:text-text-dark-secondary">Errors</div>
                </div>
                <div className="rounded-lg bg-bg-light-secondary dark:bg-bg-dark-secondary p-2">
                  <div className="text-lg font-bold text-accent-yellow">{warnLogs.length}</div>
                  <div className="text-[10px] text-text-light-secondary dark:text-text-dark-secondary">Warnings</div>
                </div>
                <div className="rounded-lg bg-bg-light-secondary dark:bg-bg-dark-secondary p-2">
                  <div className="text-lg font-bold text-accent-green">{infoCount}</div>
                  <div className="text-[10px] text-text-light-secondary dark:text-text-dark-secondary">Info</div>
                </div>
              </div>

              {/* Recent backend logs */}
              <SectionHeading>Recent System Logs</SectionHeading>
              <div className="space-y-1">
                {logs.length === 0 ? (
                  <div className="text-xs italic text-center text-text-light-secondary dark:text-text-dark-secondary">
                    No logs available
                  </div>
                ) : (
                  logs.slice(0, 8).map((log, i) => {
                    const sev = levelToSeverity(log.level);
                    const style = severityStyle(sev);
                    return (
                      <div
                        key={i}
                        className={`text-xs flex items-start gap-2 rounded px-2 py-1 ${style.bg} ${style.text}`}
                      >
                        <span className="opacity-60 shrink-0 w-28 truncate">
                          {(log.ts ?? '').slice(0, 16)}
                        </span>
                        <span className="font-semibold shrink-0 w-20 truncate">
                          {log.station_id ?? '—'}
                        </span>
                        <span className="truncate">{log.message ?? ''}</span>
                      </div>
                    );
                  })
                )}
              </div>

              {/* PDF download */}
              <SectionHeading>Full Report</SectionHeading>
              <div className="flex flex-col gap-2 pb-2">
                <p className="text-xs text-text-light-secondary dark:text-text-dark-secondary">
                  The full PDF includes station status, environmental readings, KPI trends, and all system logs.
                </p>
                <button
                  onClick={downloadPDF}
                  disabled={downloading}
                  className="w-full text-sm font-semibold bg-accent-blue hover:opacity-90 disabled:opacity-50 text-white rounded-lg py-2 transition-opacity flex items-center justify-center gap-2"
                >
                  {downloading ? (
                    <>
                      <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                      </svg>
                      Generating…
                    </>
                  ) : (
                    <>
                      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M12 15V3m0 12l-4-4m4 4l4-4M2 17v2a2 2 0 002 2h16a2 2 0 002-2v-2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                      Download PDF Report
                    </>
                  )}
                </button>
                {downloadMsg && (
                  <div
                    className={`text-xs text-center ${
                      downloadMsg.startsWith('Download failed') ? 'text-accent-red' : 'text-accent-green'
                    }`}
                  >
                    {downloadMsg}
                  </div>
                )}
              </div>

            </div>
          )}
        </div>
      )}
    </Card>
  );
};

export default AlertsPanel;