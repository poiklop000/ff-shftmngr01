import { useCallback, useMemo, useState } from 'react';
import { BarChart3, Loader2, FileDown, ExternalLink, RefreshCw, Calendar, Clock } from 'lucide-react';
import { PageHelp } from '@/components/PageHelp';
import type { Shift } from '@/types';
import { fetchDowntimeBetween, formatDuration, localDateTimeToEpoch, type DowntimeEvent } from '@/lib/downtime';
import { fetchHourlySummaryByDate, type HourlySummaryEntry } from '@/lib/counterLogs';
import {
  fetchJobsInRange,
  fetchMonitoringRecordsInRange,
  type JobSnapshotRow,
} from '@/lib/analytics';
import type { MonitoringRecord } from '@/lib/monitoring';

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
}

export function AnalyticsView({ onOpenRecord }: AnalyticsViewProps) {
  const [startAt, setStartAt] = useState(() => `${dateOffset(-6)}T00:00`);
  const [endAt, setEndAt] = useState(() => `${dateOffset(0)}T23:59`);
  const [textFilter, setTextFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('All');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [loadedRange, setLoadedRange] = useState<{ start: string; end: string } | null>(null);

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

  const handleQuick = (days: number) => {
    const st = `${dateOffset(days > 0 ? -days + 1 : 0)}T00:00`;
    const en = `${dateOffset(0)}T23:59`;
    setStartAt(st);
    setEndAt(en);
    loadData(st, en);
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

  const downtimeByReason = useMemo(() => {
    const map = new Map<string, number>();
    for (const e of downtime) {
      const key = e.reason ?? e.category ?? 'Unknown';
      map.set(key, (map.get(key) ?? 0) + (e.duration_ms ?? 0));
    }
    return Array.from(map.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);
  }, [downtime]);

  const maxReasonMs = downtimeByReason.reduce((m, [, v]) => Math.max(m, v), 0);

  const maxHourOut = useMemo(
    () => (data?.hourly ?? []).reduce((m, h) => Math.max(m, h.out), 0),
    [data],
  );

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
              "Downtime by reason - horizontal bars ranking the top reasons by total time lost.",
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
              "Open loads that record onto the Monitoring board so you can review or re-print it.",
            ],
          },
        ]}
      />

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
              <div style={{ overflowX: 'auto' }}>
                <table className="w-full text-[13px]" style={{ minWidth: 680 }}>
                  <thead>
                    <tr className="text-left text-[11px] font-bold uppercase tracking-wide text-slate-500 border-b border-slate-200">
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
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
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
                  className="app-bar-shift-select"
                  style={{ width: 'auto', fontSize: 12 }}
                  value={typeFilter}
                  onChange={(e) => setTypeFilter(e.target.value)}
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
              <div style={{ overflowX: 'auto' }}>
                <table className="w-full text-[13px]" style={{ minWidth: 720 }}>
                  <thead>
                    <tr className="text-left text-[11px] font-bold uppercase tracking-wide text-slate-500 border-b border-slate-200">
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
                    {downtime.map((e) => (
                      <tr key={e.id} className="border-b border-slate-100 hover:bg-slate-50 transition-colors" title={e.reason ?? ''}>
                        <td className="px-4 py-3 text-slate-700 whitespace-nowrap">{eventStartLabel(e)}</td>
                        <td className="px-4 py-3 text-slate-700 whitespace-nowrap">{eventDuration(e)}</td>
                        <td className="px-4 py-3">
                          <span
                            style={{
                              fontSize: 10, fontWeight: 700, borderRadius: 999, padding: '2px 8px', whiteSpace: 'nowrap',
                              color: (e.downtime_type ?? '').toUpperCase().includes('SETUP') ? '#854d0e' : (e.downtime_type ?? '').toUpperCase().includes('RUNNING_SLOW') ? '#3f6212' : '#991b1b',
                              backgroundColor: (e.downtime_type ?? '').toUpperCase().includes('SETUP') ? '#fef9c3' : (e.downtime_type ?? '').toUpperCase().includes('RUNNING_SLOW') ? '#d9f99d' : '#fee2e2',
                            }}
                          >
                            {e.downtime_type ?? '-'}
                          </span>
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
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Downtime by reason chart */}
          {downtimeByReason.length > 0 && (
            <div className="card card-blue">
              <h3>Downtime by Reason (top {downtimeByReason.length})</h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {downtimeByReason.map(([reason, ms], i) => (
                  <div key={reason}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, fontWeight: 600, marginBottom: 2 }}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '70%' }}>{reason}</span>
                      <span>{formatDuration(ms)}</span>
                    </div>
                    <div style={{ width: '100%', height: 12, backgroundColor: '#e2e8f0', borderRadius: 6, overflow: 'hidden' }}>
                      <div
                        style={{
                          width: `${maxReasonMs > 0 ? (ms / maxReasonMs) * 100 : 0}%`,
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
                <div style={{ overflowX: 'auto' }}>
                  <table className="w-full text-[13px]" style={{ minWidth: 560 }}>
                    <thead>
                      <tr className="text-left text-[11px] font-bold uppercase tracking-wide text-slate-500 border-b border-slate-200">
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
                    ['Date', 'Shift', 'SKU', 'Active Job', 'Notes', 'Saved By', 'Created At'],
                    records.map((r) => [r.record_date, r.shift_name, r.active_job?.sku ?? r.sku, r.active_job?.productName ?? '', r.notes, r.saved_by, r.created_at]),
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
              <div style={{ overflowX: 'auto' }}>
                <table className="w-full text-[13px]" style={{ minWidth: 680 }}>
                  <thead>
                    <tr className="text-left text-[11px] font-bold uppercase tracking-wide text-slate-500 border-b border-slate-200">
                      <th className="px-4 py-2.5">Date</th>
                      <th className="px-4 py-2.5">Shift</th>
                      <th className="px-4 py-2.5">SKU</th>
                      <th className="px-4 py-2.5">Active Job</th>
                      <th className="px-4 py-2.5">Notes</th>
                      <th className="px-4 py-2.5">Saved By</th>
                      <th className="px-4 py-2.5"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {records.map((r) => (
                      <tr key={r.id} className="border-b border-slate-100 hover:bg-slate-50 transition-colors">
                        <td className="px-4 py-3 text-slate-700">{r.record_date}</td>
                        <td className="px-4 py-3 text-slate-600">{r.shift_name}</td>
                        <td className="px-4 py-3 text-slate-600">{r.active_job?.sku ?? (r.sku || '-')}</td>
                        <td className="px-4 py-3 text-slate-600">{r.active_job?.productName ?? '-'}</td>
                        <td className="px-4 py-3 text-slate-600" style={{ maxWidth: 240, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.notes || '-'}</td>
                        <td className="px-4 py-3 text-slate-600">{r.saved_by || '-'}</td>
                        <td className="px-4 py-3">
                          <button type="button" className="tab-btn tab-btn-green" style={{ padding: '4px 10px', fontSize: 11 }} onClick={() => handleOpenRecord(r)}>
                            <ExternalLink size={12} /> Open
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
    </div>
  );
}
