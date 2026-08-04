import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { BarChart3, Loader2, FileDown, ExternalLink, RefreshCw, Calendar, Clock, FileText, History, MessageSquare } from 'lucide-react';
import { PageHelp } from '@/components/PageHelp';
import { DowntimeTypeBadge } from '@/components/DowntimeTypeBadge';
import { ShiftReport } from '@/components/ShiftReport';
import { AlertHistory } from '@/components/AlertHistory';
import { getActiveHours, type Shift } from '@/types';
import { fetchDowntimeBetween, formatDuration, localDateTimeToEpoch, type DowntimeComment, type DowntimeEvent } from '@/lib/downtime';
import { fetchHourlySummaryByDate, type HourlySummaryEntry } from '@/lib/counterLogs';
import {
  fetchJobsInRange,
  fetchMonitoringRecordsInRange,
  type JobSnapshotRow,
} from '@/lib/analytics';
import { fetchRecordAudit, type MonitoringRecord, type MonitoringRecordAudit } from '@/lib/monitoring';

function csvEscape(value: string | number | null | undefined): string {
  const str = String(value ?? '');
  return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function downloadCsv(filename: string, header: string[], rows: (string | number | null | undefined)[][]) {
  const lines: string[] = [];
  lines.push(header.map(csvEscape).join(','));
  for (const row of rows) lines.push(row.map(csvEscape).join(','));
  const csv = '\uFEFF' + lines.join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function toDateStr(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function dateOffset(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return toDateStr(d);
}

const ANALYTICS_PERSIST_KEY = 'ff_analytics_persist_v1';

interface AnalyticsPersistState {
  startAt: string;
  endAt: string;
  textFilter: string;
  typeFilter: string;
  loadedRange: { start: string; end: string } | null;
}

function defaultAnalyticsPersist(): AnalyticsPersistState {
  return {
    startAt: `${dateOffset(-6)}T00:00`,
    endAt: `${dateOffset(0)}T23:59`,
    textFilter: '',
    typeFilter: 'All',
    loadedRange: null,
  };
}

function loadAnalyticsPersist(): AnalyticsPersistState {
  try {
    const raw = localStorage.getItem(ANALYTICS_PERSIST_KEY);
    if (!raw) return defaultAnalyticsPersist();
    const parsed = JSON.parse(raw) as Partial<AnalyticsPersistState>;
    const fallback = defaultAnalyticsPersist();
    return {
      startAt: typeof parsed.startAt === 'string' ? parsed.startAt : fallback.startAt,
      endAt: typeof parsed.endAt === 'string' ? parsed.endAt : fallback.endAt,
      textFilter: typeof parsed.textFilter === 'string' ? parsed.textFilter : '',
      typeFilter: typeof parsed.typeFilter === 'string' ? parsed.typeFilter : 'All',
      loadedRange:
        parsed.loadedRange &&
        typeof parsed.loadedRange.start === 'string' &&
        typeof parsed.loadedRange.end === 'string'
          ? parsed.loadedRange
          : null,
    };
  } catch {
    return defaultAnalyticsPersist();
  }
}

// Convert a UTC ISO timestamp to a factory (Auckland) date-time label.
function aucklandTime(iso: string): string {
  const dt = new Date(iso);
  if (isNaN(dt.getTime())) return iso;
  return new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Pacific/Auckland',
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(dt);
}

function eventStartLabel(e: DowntimeEvent): string {
  return e.start_text ? e.start_text.slice(0, 16) : '';
}

function eventDuration(e: DowntimeEvent): string {
  return formatDuration(e.duration_ms ?? 0);
}

interface AnalyticsData {
  jobs: JobSnapshotRow[];
  downtime: DowntimeEvent[];
  hourly: HourlySummaryEntry[];
  records: MonitoringRecord[];
}

const BAR_COLORS = ['#1d4ed8', '#dc2626', '#eab308', '#16a34a', '#9333ea', '#0e7490', '#ea580c', '#64748b'];

function barColor(i: number): string {
  return BAR_COLORS[i % BAR_COLORS.length];
}

interface AnalyticsViewProps {
  onOpenRecord: (recordDate: string, shift: Shift) => Promise<void>;
  syncTick?: number;
  isAdmin?: boolean;
}

export function AnalyticsView({ onOpenRecord, syncTick = 0, isAdmin = false }: AnalyticsViewProps) {
  const [persisted] = useState(() => loadAnalyticsPersist());
  const [startAt, setStartAt] = useState(persisted.startAt);
  const [endAt, setEndAt] = useState(persisted.endAt);
  const [textFilter, setTextFilter] = useState(persisted.textFilter);
  const [typeFilter, setTypeFilter] = useState(persisted.typeFilter);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [loadedRange, setLoadedRange] = useState<{ start: string; end: string } | null>(persisted.loadedRange);
  const [reportRecord, setReportRecord] = useState<MonitoringRecord | null>(null);
  const [auditRecord, setAuditRecord] = useState<MonitoringRecord | null>(null);
  const [auditEntries, setAuditEntries] = useState<MonitoringRecordAudit[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [expandedDowntimeId, setExpandedDowntimeId] = useState<number | null>(null);

  // Keep the Analytics filters and last loaded range in localStorage so the
  // page remembers them when the user navigates away and comes back.
  useEffect(() => {
    try {
      localStorage.setItem(ANALYTICS_PERSIST_KEY, JSON.stringify({ startAt, endAt, textFilter, typeFilter, loadedRange }));
    } catch {
      // ignore storage failures
    }
  }, [startAt, endAt, textFilter, typeFilter, loadedRange]);

  const loadData = useCallback(async (start: string, end: string) => {
    if (!start || !end) {
      setError('Select both a start and an end date and time.');
      return;
    }
    if (start > end) {
      setError('Start cannot be after the end.');
      return;
    }
    const sEpoch = localDateTimeToEpoch(start);
    const eEpoch = localDateTimeToEpoch(end);
    if (Number.isNaN(sEpoch) || Number.isNaN(eEpoch)) {
      setError('Enter valid start and end date/times.');
      return;
    }
    setLoading(true);
    setError(null);
    setMsg(null);
    try {
      const startDay = start.slice(0, 10);
      const endDay = end.slice(0, 10);
      const [jobs, downtime, hourlyAll, records] = await Promise.all([
        fetchJobsInRange(start, end),
        fetchDowntimeBetween(start, end),
        fetchHourlySummaryByDate(startDay, endDay),
        fetchMonitoringRecordsInRange(startDay, endDay),
      ]);
      const hourly = hourlyAll.filter((h) => h.start >= sEpoch && h.start <= eEpoch);
      setData({ jobs, downtime, hourly, records });
      setLoadedRange({ start, end });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load analytics data');
      setData(null);
      setLoadedRange(null);
    } finally {
      setLoading(false);
    }
  }, []);

  // Restore the previously loaded range (if any) automatically on mount so
  // returning to Analytics shows the same data without re-selecting a range.
  useEffect(() => {
    const p = loadAnalyticsPersist();
    if (p.loadedRange?.start && p.loadedRange?.end) {
      loadData(p.loadedRange.start, p.loadedRange.end);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // After a header Sync completes, reload the currently loaded range so the
  // freshly captured data shows immediately.
  useEffect(() => {
    if (syncTick > 0 && loadedRange?.start && loadedRange?.end) {
      loadData(loadedRange.start, loadedRange.end);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncTick]);

  const handleQuick = (days: number) => {
    const st = `${dateOffset(days > 0 ? -days + 1 : 0)}T00:00`;
    const en = `${dateOffset(0)}T23:59`;
    setStartAt(st);
    setEndAt(en);
    loadData(st, en);
  };

  const handleOpenHistory = async (r: MonitoringRecord) => {
    setAuditRecord(r);
    setAuditEntries([]);
    setAuditLoading(true);
    try {
      setAuditEntries(await fetchRecordAudit(r.id));
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Failed to load record history');
    } finally {
      setAuditLoading(false);
    }
  };

  // Group job snapshots into one row per distinct OFS job.
  const jobs = useMemo(() => {
    if (!data) return [];
    const map = new Map<number, { rows: JobSnapshotRow[] }>();
    for (const row of data.jobs) {
      if (row.job_id === null) continue;
      const entry = map.get(row.job_id) ?? { rows: [] };
      entry.rows.push(row);
      map.set(row.job_id, entry);
    }
    const list: {
      jobId: number;
      product: string;
      sku: string;
      quantity: number;
      produced: number;
      progressPct: number;
      firstCapture: string;
      lastCapture: string;
      shifts: string[];
      runs: number;
    }[] = [];
    for (const [jobId, { rows }] of map) {
      const last = rows[rows.length - 1]!;
      const first = rows[0]!;
      const shifts = Array.from(new Set(rows.map((r) => r.shift_name).filter(Boolean))) as string[];
      list.push({
        jobId,
        product: last.order_name ?? last.product_name ?? `Job ${jobId}`,
        sku: last.sku ?? '',
        quantity: last.quantity ?? 0,
        produced: last.produced ?? 0,
        progressPct: last.progress_pct ?? 0,
        firstCapture: first.capture_time,
        lastCapture: last.capture_time,
        shifts,
        runs: rows.length,
      });
    }
    list.sort((a, b) => a.jobId - b.jobId);
    return list;
  }, [data]);

  const downtime = useMemo(() => {
    if (!data) return [];
    let list = data.downtime;
    if (typeFilter !== 'All') {
      list = list.filter((e) => (e.downtime_type ?? '') === typeFilter);
    }
    if (textFilter.trim()) {
      const q = textFilter.trim().toLowerCase();
      list = list.filter((e) =>
        (e.reason ?? '').toLowerCase().includes(q) ||
        (e.category ?? '').toLowerCase().includes(q) ||
        (e.state ?? '').toLowerCase().includes(q),
      );
    }
    return list;
  }, [data, typeFilter, textFilter]);

  const downtimeTypes = useMemo(() => {
    if (!data) return [];
    return Array.from(new Set(data.downtime.map((e) => e.downtime_type).filter(Boolean))) as string[];
  }, [data]);

  const records = useMemo(() => (data ? data.records : []), [data]);

  const { totalDowntimeMs, downtimeCount, longestDowntimeMs, uptimePct, totalOut, avgEfficiency } = useMemo(() => {
    const totalDowntimeMs = downtime.reduce((sum, e) => sum + (e.duration_ms ?? 0), 0);
    const longestDowntimeMs = downtime.reduce((max, e) => Math.max(max, e.duration_ms ?? 0), 0);
    const days = loadedRange ? Math.max(1, Math.round((new Date(loadedRange.end).getTime() - new Date(loadedRange.start).getTime()) / 86400000) + 1) : 1;
    const uptimePct = Math.max(0, Math.min(100, 100 - (totalDowntimeMs / (days * 86400000)) * 100));
    const totalOut = (data?.hourly ?? []).reduce((sum, h) => sum + h.out, 0);
    let effSum = 0;
    let effCount = 0;
    for (const h of data?.hourly ?? []) {
      if (h.rated > 0) {
        effSum += (h.out / h.rated) * 100;
        effCount++;
      }
    }
    return {
      totalDowntimeMs,
      downtimeCount: downtime.length,
      longestDowntimeMs,
      uptimePct,
      totalOut,
      avgEfficiency: effCount > 0 ? effSum / effCount : 0,
    };
  }, [downtime, data, loadedRange]);

  const maxHourOut = useMemo(
    () => (data?.hourly ?? []).reduce((m, h) => Math.max(m, h.out), 0),
    [data],
  );

  const downtimeByCategory = useMemo(() => {
    const map = new Map<string, { ms: number; count: number }>();
    for (const e of downtime) {
      const key = e.category ?? e.reason ?? 'Unknown';
      const entry = map.get(key) ?? { ms: 0, count: 0 };
      entry.ms += e.duration_ms ?? 0;
      entry.count += 1;
      map.set(key, entry);
    }
    return Array.from(map.entries())
      .map(([category, { ms, count }]) => ({ category, ms, count }))
      .sort((a, b) => b.ms - a.ms);
  }, [downtime]);

  const maxCategoryMs = downtimeByCategory.reduce((m, c) => Math.max(m, c.ms), 0);

  const hourLabels = useMemo(() => {
    if (!data) return [];
    return data.hourly.map((h) => {
      const datePart = h.startText ? h.startText.slice(0, 10) : '';
      const dateShort = datePart ? `${datePart.slice(8, 10)}/${datePart.slice(5, 7)}` : '';
      return dateShort ? `${dateShort} ${h.hour}` : h.hour;
    });
  }, [data]);

  const handleExportAll = () => {
    if (!data) return;
    const rows: (string | number | null | undefined)[][] = [];
    rows.push(['SECTION', 'JOBS']);
    rows.push(['Job', 'Product', 'SKU', 'Target', 'Produced', 'Progress %', 'First Capture', 'Last Capture', 'Runs']);
    for (const j of jobs) {
      rows.push([`Job ${j.jobId}`, j.product, j.sku, j.quantity, j.produced, j.progressPct.toFixed(1), aucklandTime(j.firstCapture), aucklandTime(j.lastCapture), j.runs]);
    }
    rows.push(['SECTION', 'DOWNTIME']);
    rows.push(['Start', 'Duration (ms)', 'Duration', 'Type', 'Category', 'Reason', 'Crew', 'Status']);
    for (const e of downtime) {
      rows.push([eventStartLabel(e), e.duration_ms, eventDuration(e), e.downtime_type, e.category, e.reason, e.crew_name, e.resolved ? 'Resolved' : 'Ongoing']);
    }
    rows.push(['SECTION', 'HOURLY PRODUCTION']);
    rows.push(['Date', 'Hour', 'In', 'Out', 'Rated']);
    for (const h of data.hourly) {
      const datePart = h.startText ? h.startText.slice(0, 10) : '';
      rows.push([datePart, h.hour, h.in, h.out, h.rated]);
    }
    rows.push(['SECTION', 'SAVED RECORDS']);
    rows.push(['Date', 'Shift', 'SKU', 'Notes', 'Saved By', 'Created At']);
    for (const r of records) {
      rows.push([r.record_date, r.shift_name, r.active_job?.sku ?? r.sku, r.notes, r.saved_by, r.created_at]);
    }
    downloadCsv(`analytics_${loadedRange?.start}_to_${loadedRange?.end}.csv`, ['Analytics Export'], rows);
    setMsg('CSV exported');
  };

  const handleOpenRecord = async (record: MonitoringRecord) => {
    try {
      await onOpenRecord(record.record_date, record.shift_name as Shift);
      setMsg('Record loaded onto the board');
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Failed to load record');
    }
  };

  const isLoading = loading;
  const hasData = !!data;

  return (
    <div>
      <PageHelp
        title="Analytics"
        intro="Review captured data across any date range: downtime events, active jobs, hourly production, and saved monitoring records — with charts and CSV exports for further analysis."
        sections={[
          {
            title: "Selecting a range",
            items: [
              "Choose a start and end date and time, then click Load Data. Quick buttons (Today, 7 Days, 14 Days, 30 Days) set common ranges instantly.",
              "The range uses the factory console clock, so overnight shifts and UTC timestamps are aligned to the line's local date and time.",
              "The selected date/time window applies to jobs, downtime events, hourly production, and saved records.",
            ],
          },
          {
            title: "Filtering",
            items: [
              "Type - on the downtime table, filter to unplanned, planned, setup, or running-slow events.",
              "Search - type text to find downtime reasons or categories containing that text.",
            ],
          },
          {
            title: "Charts",
            items: [
              "Downtime by category - horizontal bars ranking the categories with the most time lost.",
              "Output per hour - vertical bars showing how many units each hour produced across the range.",
              "Job progress - one bar per job showing how far it got toward its target quantity.",
            ],
          },
          {
            title: "Exporting",
            items: [
              "Each table has its own Export CSV button for opening the data in Excel.",
              "Export All downloads jobs, downtime, hourly production, and saved records in one CSV file.",
            ],
          },
          {
            title: "Saved records",
            items: [
              "Saved monitoring records for the range are listed at the bottom with their date, shift, SKU, and notes.",
              "Open loads that record onto the Monitoring board so you can review or re-print it. Report opens the saved report snapshot in a formatted view, exactly as it was printed when saved.",
            ],
          },
        ]}
      />

      {isAdmin && <AlertHistory />}

      <div className="card card-blue">
        <h3 style={{ margin: 0, border: 'none', padding: 0, borderBottom: '1px solid currentColor', paddingBottom: 6 }}>
          <BarChart3 size={16} style={{ verticalAlign: 'text-bottom', marginRight: 6 }} />
          Analytics — Data Review
        </h3>

        <div className="card-row" style={{ flexWrap: 'wrap', gap: 10, marginTop: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Calendar size={14} />
            <span style={{ fontSize: 12, fontWeight: 700 }}>From</span>
            <input
              type="datetime-local"
              className="card-date-input"
              value={startAt}
              max={endAt}
              onChange={(e) => setStartAt(e.target.value)}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Clock size={14} />
            <span style={{ fontSize: 12, fontWeight: 700 }}>To</span>
            <input
              type="datetime-local"
              className="card-date-input"
              value={endAt}
              min={startAt}
              onChange={(e) => setEndAt(e.target.value)}
            />
          </div>
          <button type="button" className="tab-btn tab-btn-blue" onClick={() => loadData(startAt, endAt)} disabled={isLoading}>
            {isLoading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            Load Data
          </button>
        </div>

        <div className="card-row" style={{ flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
          {[
            { label: 'Today', days: 1 },
            { label: '7 Days', days: 7 },
            { label: '14 Days', days: 14 },
            { label: '30 Days', days: 30 },
          ].map((q) => (
            <button key={q.label} type="button" className="tab-btn tab-btn-amber" onClick={() => handleQuick(q.days)} disabled={isLoading}>
              {q.label}
            </button>
          ))}
        </div>

        {loadedRange && (
          <div style={{ marginTop: 8, fontSize: 12, fontWeight: 600, color: '#1e40af' }}>
            Showing {loadedRange.start.replace('T', ' ')} to {loadedRange.end.replace('T', ' ')}
          </div>
        )}
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 text-red-800 p-4 mb-4">
          <p className="m-0 text-[13px] font-semibold">{error}</p>
        </div>
      )}

      {isLoading && (
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 8, padding: 24, fontSize: 13, fontWeight: 600, color: '#475569' }}>
          <Loader2 size={16} className="animate-spin" /> Loading analytics data…
        </div>
      )}

      {hasData && !isLoading && (
        <>
          <div className="card-row" style={{ flexWrap: 'wrap', gap: 10, marginBottom: 4 }}>
            <button type="button" className="tab-btn tab-btn-blue" onClick={handleExportAll}>
              <FileDown size={14} /> Export All CSV
            </button>
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 15 }}>
            <div className="card card-blue">
              <div className="card-row"><span>Total Downtime</span><span className="card-value">{formatDuration(totalDowntimeMs)}</span></div>
            </div>
            <div className="card card-blue">
              <div className="card-row"><span>Downtime Events</span><span className="card-value">{downtimeCount.toLocaleString()}</span></div>
            </div>
            <div className="card card-green">
              <div className="card-row"><span>Total Output</span><span className="card-value">{totalOut.toLocaleString()}</span></div>
            </div>
            <div className="card card-green">
              <div className="card-row"><span>Avg Efficiency</span><span className="card-value">{avgEfficiency.toFixed(1)}%</span></div>
            </div>
            <div className="card card-teal">
              <div className="card-row"><span>Distinct Jobs</span><span className="card-value">{jobs.length}</span></div>
            </div>
            <div className="card card-teal">
              <div className="card-row"><span>Longest Downtime</span><span className="card-value">{formatDuration(longestDowntimeMs)}</span></div>
            </div>
            <div className="card card-teal">
              <div className="card-row"><span>Uptime (est.)</span><span className="card-value">{uptimePct.toFixed(1)}%</span></div>
            </div>
          </div>

          {/* Jobs */}
          <div className="card card-blue">
            <h3 style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
              <span>Active Jobs</span>
              <button
                type="button"
                className="tab-btn tab-btn-blue"
                style={{ padding: '4px 10px', fontSize: 11 }}
                onClick={() => {
                  downloadCsv(
                    `analytics_jobs_${loadedRange?.start}_to_${loadedRange?.end}.csv`,
                    ['Job', 'Product', 'SKU', 'Target', 'Produced', 'Progress %', 'First Capture', 'Last Capture', 'Shifts', 'Runs'],
                    jobs.map((j) => [`Job ${j.jobId}`, j.product, j.sku, j.quantity, j.produced, j.progressPct.toFixed(1), aucklandTime(j.firstCapture), aucklandTime(j.lastCapture), j.shifts.join(' | '), j.runs]),
                  );
                  setMsg('Jobs CSV exported');
                }}
              >
                <FileDown size={12} /> CSV
              </button>
            </h3>
            {jobs.length === 0 ? (
              <div style={{ fontSize: 12, color: '#64748b', fontWeight: 500, padding: 8 }}>
                No jobs captured in this range.
              </div>
            ) : (
              <div className="card-scroll">
                <table className="w-full text-[13px]" style={{ minWidth: 680 }}>
                  <thead>
                    <tr className="text-left text-[11px] font-bold uppercase tracking-wide text-slate-800 border-b border-slate-200">
                      <th className="px-4 py-2.5">Job</th>
                      <th className="px-4 py-2.5">SKU</th>
                      <th className="px-4 py-2.5">Target</th>
                      <th className="px-4 py-2.5">Produced</th>
                      <th className="px-4 py-2.5">Progress</th>
                      <th className="px-4 py-2.5">First / Last Capture</th>
                      <th className="px-4 py-2.5">Shifts</th>
                      <th className="px-4 py-2.5">Snapshots</th>
                    </tr>
                  </thead>
                  <tbody>
                    {jobs.map((j) => (
                      <tr key={j.jobId} className="border-b border-slate-100 hover:bg-slate-50 transition-colors">
                        <td className="px-4 py-3 text-slate-700">
                          <span style={{ fontSize: 10, fontWeight: 700, color: '#1d4ed8', backgroundColor: '#dbeafe', border: '1px solid #bfdbfe', borderRadius: 999, padding: '2px 8px', whiteSpace: 'nowrap' }}>
                            Job {j.jobId}
                          </span>
                          <div style={{ fontSize: 12, marginTop: 4 }}>{j.product}</div>
                        </td>
                        <td className="px-4 py-3 text-slate-600">{j.sku || '-'}</td>
                        <td className="px-4 py-3 text-slate-600">{j.quantity.toLocaleString()}</td>
                        <td className="px-4 py-3 text-slate-600">{j.produced.toLocaleString()}</td>
                        <td className="px-4 py-3 text-slate-700">
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <div style={{ width: 80, height: 8, backgroundColor: '#e2e8f0', borderRadius: 999, overflow: 'hidden' }}>
                              <div style={{ width: `${Math.min(100, Math.max(0, j.progressPct))}%`, height: '100%', backgroundColor: j.progressPct >= 100 ? '#16a34a' : '#1d4ed8' }} />
                            </div>
                            <span>{j.progressPct.toFixed(0)}%</span>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-slate-600 whitespace-nowrap">
                          <div style={{ fontSize: 12 }}>{aucklandTime(j.firstCapture)}</div>
                          <div style={{ fontSize: 12, color: '#64748b' }}>{aucklandTime(j.lastCapture)}</div>
                        </td>
                        <td className="px-4 py-3 text-slate-600">{j.shifts.length > 0 ? j.shifts.join(', ') : '-'}</td>
                        <td className="px-4 py-3 text-slate-600">{j.runs}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Job progress chart */}
          {jobs.length > 0 && (
            <div className="card card-blue">
              <h3>Job Progress</h3>
              <div className="card-scroll-sm" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {jobs.map((j, i) => (
                  <div key={j.jobId}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, fontWeight: 600, marginBottom: 2 }}>
                      <span>Job {j.jobId} — {j.product}</span>
                      <span>{j.progressPct.toFixed(0)}%</span>
                    </div>
                    <div style={{ width: '100%', height: 12, backgroundColor: '#e2e8f0', borderRadius: 6, overflow: 'hidden' }}>
                      <div
                        style={{
                          width: `${Math.min(100, Math.max(0, j.progressPct))}%`,
                          height: '100%',
                          backgroundColor: barColor(i),
                          borderRadius: 6,
                          transition: 'width 0.3s ease',
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Downtime */}
          <div className="card card-blue">
            <h3 style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
              <span>Downtime Events</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <input
                  type="search"
                  placeholder="Search reason…"
                  value={textFilter}
                  onChange={(e) => setTextFilter(e.target.value)}
                  style={{ fontSize: 12, padding: '4px 8px', borderRadius: 6, border: '1px solid #cbd5e1', maxWidth: 160 }}
                />
                <select
                  value={typeFilter}
                  onChange={(e) => setTypeFilter(e.target.value)}
                  style={{ fontSize: 12, padding: '4px 8px', borderRadius: 6, border: '1px solid #cbd5e1', color: '#0f172a', backgroundColor: '#fff' }}
                >
                  <option value="All">All Types</option>
                  {downtimeTypes.map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
                <button
                  type="button"
                  className="tab-btn tab-btn-blue"
                  style={{ padding: '4px 10px', fontSize: 11 }}
                  onClick={() => {
                    downloadCsv(
                      `analytics_downtime_${loadedRange?.start}_to_${loadedRange?.end}.csv`,
                      ['Start', 'Duration', 'Type', 'Category', 'Reason', 'Crew', 'Status'],
                      downtime.map((e) => [eventStartLabel(e), eventDuration(e), e.downtime_type, e.category, e.reason, e.crew_name, e.resolved ? 'Resolved' : 'Ongoing']),
                    );
                    setMsg('Downtime CSV exported');
                  }}
                >
                  <FileDown size={12} /> CSV
                </button>
              </div>
            </h3>
            {downtime.length === 0 ? (
              <div style={{ fontSize: 12, color: '#64748b', fontWeight: 500, padding: 8 }}>
                No downtime events in this range.
              </div>
            ) : (
              <div className="card-scroll">
                <table className="w-full text-[13px]" style={{ minWidth: 720 }}>
                  <thead>
                    <tr className="text-left text-[11px] font-bold uppercase tracking-wide text-slate-800 border-b border-slate-200">
                      <th className="px-4 py-2.5">Start</th>
                      <th className="px-4 py-2.5">Duration</th>
                      <th className="px-4 py-2.5">Type</th>
                      <th className="px-4 py-2.5">Category</th>
                      <th className="px-4 py-2.5">Reason</th>
                      <th className="px-4 py-2.5">Crew</th>
                      <th className="px-4 py-2.5">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {downtime.map((e) => {
                      const hasComments = e.comments && e.comments.length > 0;
                      const isExpanded = expandedDowntimeId === e.id;
                      return (
                        <Fragment key={e.id}>
                          <tr
                            className={`border-b border-slate-100 hover:bg-slate-50 transition-colors ${isExpanded ? 'bg-slate-50' : ''}`}
                            onClick={() => hasComments && setExpandedDowntimeId(isExpanded ? null : e.id)}
                            style={{ cursor: hasComments ? 'pointer' : 'default' }}
                            title={e.reason ?? ''}
                          >
                            <td className="px-4 py-3 text-slate-700 whitespace-nowrap">
                              <div className="flex items-center gap-1.5">
                                {hasComments && (
                                  <MessageSquare size={13} className="text-brand-600 shrink-0" />
                                )}
                                {eventStartLabel(e)}
                              </div>
                            </td>
                            <td className="px-4 py-3 text-slate-700 whitespace-nowrap">{eventDuration(e)}</td>
                            <td className="px-4 py-3">
                              <DowntimeTypeBadge type={e.downtime_type} />
                            </td>
                            <td className="px-4 py-3 text-slate-600">{e.category ?? '-'}</td>
                            <td className="px-4 py-3 text-slate-700" style={{ maxWidth: 260 }}>{e.reason ?? '-'}</td>
                            <td className="px-4 py-3 text-slate-600">{e.crew_name ?? '-'}</td>
                            <td className="px-4 py-3">
                              <span style={{ fontSize: 11, fontWeight: 700, color: e.resolved ? '#166534' : '#b91c1c' }}>
                                {e.resolved ? 'Resolved' : 'Ongoing'}
                              </span>
                            </td>
                          </tr>
                          {isExpanded && hasComments && (
                            <tr className="border-b border-slate-100 bg-slate-50/50">
                              <td colSpan={7} className="px-4 py-3">
                                <CommentList comments={e.comments!} />
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Top downtime by category chart */}
          {downtimeByCategory.length > 0 && (
            <div className="card card-blue">
              <h3>Downtime by Category</h3>
              <div className="card-scroll-sm" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {downtimeByCategory.map(({ category, ms, count }, i) => (
                  <div key={category}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, fontWeight: 600, marginBottom: 2 }}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '70%' }}>{category}</span>
                      <span>{formatDuration(ms)} · {count} {count === 1 ? 'event' : 'events'}</span>
                    </div>
                    <div style={{ width: '100%', height: 12, backgroundColor: '#e2e8f0', borderRadius: 6, overflow: 'hidden' }}>
                      <div
                        style={{
                          width: `${maxCategoryMs > 0 ? (ms / maxCategoryMs) * 100 : 0}%`,
                          height: '100%',
                          backgroundColor: barColor(i),
                          borderRadius: 6,
                          transition: 'width 0.3s ease',
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Hourly production */}
          <div className="card card-green">
            <h3 style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
              <span>Hourly Production</span>
              <button
                type="button"
                className="tab-btn tab-btn-blue"
                style={{ padding: '4px 10px', fontSize: 11 }}
                onClick={() => {
                  downloadCsv(
                    `analytics_hourly_${loadedRange?.start}_to_${loadedRange?.end}.csv`,
                    ['Date', 'Hour', 'In', 'Out', 'Rated'],
                    data.hourly.map((h) => [h.startText ? h.startText.slice(0, 10) : '', h.hour, h.in, h.out, h.rated]),
                  );
                  setMsg('Hourly CSV exported');
                }}
              >
                <FileDown size={12} /> CSV
              </button>
            </h3>
            {data.hourly.length === 0 ? (
              <div style={{ fontSize: 12, color: '#64748b', fontWeight: 500, padding: 8 }}>
                No hourly data available for this range.
              </div>
            ) : (
              <>
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 120, overflowX: 'auto', paddingBottom: 4 }}>
                  {data.hourly.map((h, i) => (
                    <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', height: '100%', minWidth: 34, flexShrink: 0 }}>
                      <div
                        title={`${hourLabels[i] ?? h.hour}: ${h.out.toLocaleString()}`}
                        style={{
                          width: 22,
                          height: `${maxHourOut > 0 ? Math.max(2, (h.out / maxHourOut) * 100) : 2}%`,
                          backgroundColor: h.out > 0 ? '#16a34a' : '#e2e8f0',
                          borderRadius: '4px 4px 0 0',
                        }}
                      />
                    </div>
                  ))}
                </div>
                <div className="card-scroll">
                  <table className="w-full text-[13px]" style={{ minWidth: 560 }}>
                    <thead>
                      <tr className="text-left text-[11px] font-bold uppercase tracking-wide text-slate-800 border-b border-slate-200">
                        <th className="px-4 py-2.5">Date</th>
                        <th className="px-4 py-2.5">Hour</th>
                        <th className="px-4 py-2.5">In</th>
                        <th className="px-4 py-2.5">Out</th>
                        <th className="px-4 py-2.5">Rated</th>
                        <th className="px-4 py-2.5">Efficiency</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.hourly.map((h, i) => {
                        const eff = h.rated > 0 ? ((h.out / h.rated) * 100).toFixed(1) : '0.0';
                        return (
                          <tr key={i} className="border-b border-slate-100 hover:bg-slate-50 transition-colors">
                            <td className="px-4 py-3 text-slate-600">{h.startText ? h.startText.slice(0, 10) : '-'}</td>
                            <td className="px-4 py-3 text-slate-700">{h.hour}</td>
                            <td className="px-4 py-3 text-slate-600">{h.in.toLocaleString()}</td>
                            <td className="px-4 py-3 text-slate-700">{h.out.toLocaleString()}</td>
                            <td className="px-4 py-3 text-slate-600">{h.rated.toLocaleString()}</td>
                            <td className="px-4 py-3" style={{ color: h.rated > 0 && (h.out / h.rated) >= 0.7 ? '#166534' : '#b91c1c', fontWeight: 700 }}>{eff}%</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>

          {/* Saved records */}
          <div className="card card-teal">
            <h3 style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
              <span>Saved Monitoring Records</span>
              <button
                type="button"
                className="tab-btn tab-btn-blue"
                style={{ padding: '4px 10px', fontSize: 11 }}
                onClick={() => {
                  downloadCsv(
                    `analytics_records_${loadedRange?.start}_to_${loadedRange?.end}.csv`,
                    ['Date', 'Shift', 'Saved By'],
                    records.map((r) => [r.record_date, r.shift_name, r.saved_by]),
                  );
                  setMsg('Records CSV exported');
                }}
              >
                <FileDown size={12} /> CSV
              </button>
            </h3>
            {records.length === 0 ? (
              <div style={{ fontSize: 12, color: '#64748b', fontWeight: 500, padding: 8 }}>
                No saved monitoring records in this range.
              </div>
            ) : (
              <div className="card-scroll">
                <table className="w-full text-[13px]" style={{ minWidth: 420 }}>
                  <thead>
                    <tr className="text-left text-[11px] font-bold uppercase tracking-wide text-slate-800 border-b border-slate-200">
                      <th className="px-4 py-2.5">Date</th>
                      <th className="px-4 py-2.5">Shift</th>
                      <th className="px-4 py-2.5">Saved By</th>
                      <th className="px-4 py-2.5"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {records.map((r) => (
                      <tr key={r.id} className="border-b border-slate-100 hover:bg-slate-50 transition-colors">
                        <td className="px-4 py-3 text-slate-700">{r.record_date}</td>
                        <td className="px-4 py-3 text-slate-600">{r.shift_name}</td>
                        <td className="px-4 py-3 text-slate-600">{r.saved_by || '-'}</td>
                        <td className="px-4 py-3">
                          <button type="button" className="tab-btn tab-btn-green" style={{ padding: '4px 10px', fontSize: 11, marginRight: 6 }} onClick={() => handleOpenRecord(r)}>
                            <ExternalLink size={12} /> Open
                          </button>
                          <button type="button" className="tab-btn tab-btn-blue" style={{ padding: '4px 10px', fontSize: 11 }} onClick={() => setReportRecord(r)}>
                            <FileText size={12} /> Report
                          </button>
                          <button type="button" className="tab-btn tab-btn-purple" style={{ padding: '4px 10px', fontSize: 11, marginLeft: 6 }} onClick={() => handleOpenHistory(r)}>
                            <History size={12} /> History
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {msg && (
        <div style={{ textAlign: 'center', marginTop: 10, fontSize: 12, fontWeight: 600, color: '#166534' }}>
          {msg}
        </div>
      )}

      {reportRecord && (
        <div className="modal-overlay" onClick={() => setReportRecord(null)}>
          <div className="modal-card report-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Saved Report — {reportRecord.shift_name} · {reportRecord.record_date}</h2>
              <button type="button" className="modal-close-btn" onClick={() => setReportRecord(null)} aria-label="Close">✕</button>
            </div>
            <ShiftReport
              shift={reportRecord.shift_name as Shift}
              date={reportRecord.record_date}
              hours={reportRecord.hours?.length ? reportRecord.hours : getActiveHours(reportRecord.shift_name as Shift, [])}
              boardData={reportRecord.board_data}
              notes={reportRecord.notes ?? ''}
              sku={reportRecord.sku ?? ''}
              downtimeEvents={reportRecord.downtime_snapshot ?? []}
            />
          </div>
        </div>
      )}

      {auditRecord && (
        <div className="modal-overlay" onClick={() => setAuditRecord(null)}>
          <div className="modal-card" style={{ maxWidth: 640 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Record History — {auditRecord.shift_name} · {auditRecord.record_date}</h2>
              <button type="button" className="modal-close-btn" onClick={() => setAuditRecord(null)} aria-label="Close">✕</button>
            </div>
            <div style={{ maxHeight: '60vh', overflowY: 'auto' }}>
              {auditLoading ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: 12, fontSize: 12, color: '#64748b', fontWeight: 600 }}>
                  <Loader2 size={13} className="animate-spin" /> Loading save history…
                </div>
              ) : auditEntries.length === 0 ? (
                <div style={{ fontSize: 12, color: '#64748b', fontWeight: 500, padding: 12 }}>
                  No save history recorded for this record yet.
                </div>
              ) : (
                <table className="w-full text-[13px]" style={{ minWidth: 520 }}>
                  <thead>
                    <tr className="text-left text-[11px] font-bold uppercase tracking-wide text-slate-800 border-b border-slate-200">
                      <th className="px-4 py-2.5">When</th>
                      <th className="px-4 py-2.5">User</th>
                      <th className="px-4 py-2.5">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {auditEntries.map((a) => (
                      <tr key={a.id} className="border-b border-slate-100 hover:bg-slate-50 transition-colors">
                        <td className="px-4 py-3 text-slate-600">{aucklandTime(a.created_at)}</td>
                        <td className="px-4 py-3 text-slate-700">{a.saved_by || '-'}</td>
                        <td className="px-4 py-3">
                          {a.action === 'create' ? (
                            <span style={{ fontSize: 11, fontWeight: 700, color: '#15803d', backgroundColor: '#dcfce7', border: '1px solid #bbf7d0', borderRadius: 999, padding: '2px 10px', whiteSpace: 'nowrap' }}>Created</span>
                          ) : (
                            <span style={{ fontSize: 11, fontWeight: 700, color: '#b45309', backgroundColor: '#fef3c7', border: '1px solid #fde68a', borderRadius: 999, padding: '2px 10px', whiteSpace: 'nowrap' }}>Overwritten</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function CommentList({ comments }: { comments: DowntimeComment[] }) {
  return (
    <div className="space-y-2">
      <div className="text-[11px] font-bold uppercase tracking-wide text-slate-500 mb-1">
        Operator Comments
      </div>
      {comments.map((c, i) => (
        <div key={i} className="flex items-start gap-2 text-[12px] text-slate-700">
          <MessageSquare size={12} className="text-brand-500 mt-0.5 shrink-0" />
          <div>
            <span className="font-semibold">{c.userName}</span>
            {c.crewName && <span className="text-slate-400"> · {c.crewName}</span>}
            <span className="text-slate-400 ml-1.5">
              {new Date(c.commentTimestamp).toLocaleString('en-AU', {
                day: '2-digit',
                month: 'short',
                hour: '2-digit',
                minute: '2-digit',
              })}
            </span>
            <p className="m-0 mt-0.5 text-slate-600">{c.text}</p>
          </div>
        </div>
      ))}
    </div>
  );
}
