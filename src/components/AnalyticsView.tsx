import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BarChart3, Loader2, FileDown, RefreshCw, Calendar, Clock, MessageSquare, Pencil, Check, X, RotateCcw, AlertTriangle, Sparkles, Copy, Download, Send } from 'lucide-react';
import { PageHelp } from '@/components/PageHelp';
import { CheckboxDropdown } from '@/components/CheckboxDropdown';
import { DowntimeTypeBadge } from '@/components/DowntimeTypeBadge';
import { DowntimeEventEdit } from '@/components/DowntimeEventEdit';
import { fetchDowntimeBetween, formatDuration, localDateTimeToEpoch, type DowntimeComment, type DowntimeEvent } from '@/lib/downtime';
import { fetchHourlySummaryByDate, type HourlySummaryEntry } from '@/lib/counterLogs';
import {
  fetchJobsInRange,
  fetchLatestJobRates,
  type JobSnapshotRow,
} from '@/lib/analytics';
import { fetchOverridesForJobs, saveJobOverride, deleteJobOverride, type JobOverride } from '@/lib/jobOverrides';
import { fetchAiSummaryStream, sendAiChatMessage, copySummaryToClipboard, downloadSummaryTxt, buildPrompt, type ChatMessage, type AiSummaryPayload } from '@/lib/aiSummary';
import { loadAiModel, saveAiModel, AI_MODELS, type AiModelId } from '@/lib/aiConfig';
import type { Role } from '@/lib/auth';

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

// Which job was running at the start of the given hour. Snapshots are sorted
// oldest-first; the first snapshot captured within the hour is the job at the
// hour's start, otherwise the job from the most recent snapshot before it.
function activeJobForHour(hourStartEpoch: number, snapshots: JobSnapshotRow[]): number | null {
  const hourEnd = hourStartEpoch + 3600000;
  let lastBefore: number | null = null;
  for (const row of snapshots) {
    const t = new Date(row.capture_time).getTime();
    if (t >= hourStartEpoch && t < hourEnd) return row.job_id;
    if (t < hourStartEpoch) lastBefore = row.job_id;
    if (t >= hourEnd) break;
  }
  return lastBefore;
}

// Which job was running at a specific moment. Downtime events don't carry a
// real job id (OFS reports jobId 0), so the job is derived from the most recent
// job snapshot at or before the event's start time.
function jobAtEpoch(epoch: number, snapshots: JobSnapshotRow[]): number | null {
  let last: number | null = null;
  for (const row of snapshots) {
    if (new Date(row.capture_time).getTime() <= epoch) last = row.job_id;
    else break;
  }
  return last;
}

// Which job a setup/changeover event belongs to. A setup prepares the job being
// brought onto the line, and OFS activates that job the moment setup begins —
// but job snapshots are ~5 minutes apart, so the last snapshot before the
// setup's start can still show the previous job (e.g. a setup starting at 14:19
// is bucketed under the job that was still running at the 14:15 snapshot).
// Attribute the setup to the job from the first snapshot at or after its start,
// falling back to the job running at its start when no later snapshot exists.
function jobForEvent(e: DowntimeEvent, snapshots: JobSnapshotRow[]): number | null {
  if ((e.downtime_type ?? '').toUpperCase() === 'SETUP') {
    for (const row of snapshots) {
      if (new Date(row.capture_time).getTime() >= e.start_epoch) return row.job_id;
    }
  }
  return jobAtEpoch(e.start_epoch, snapshots);
}

// Resolves the job a captured setup/slow event belongs to, in order of
// reliability:
//   1. The event's own job id (express-history spans carry one from OFS).
//   2. The captured product (metadata.order_client_id / order) matched against
//      the jobs in range by SKU / order name. This is timing-independent and
//      correct even when OFS lags switching the active job several minutes
//      after the setup span started (OFS leaves setup spans jobId-less).
//   3. Snapshot timing heuristics (jobForEvent) as a last resort for events
//      with no captured product (e.g. a generic "Setup / Changeover").
// When several jobs match the same product, the one whose first capture is the
// earliest at/after the event start is the job the setup brought onto the line.
function buildJobProductIndex(snapshots: JobSnapshotRow[]) {
  const bySku = new Map<string, number[]>();
  const byOrderName = new Map<string, number[]>();
  const firstCapture = new Map<number, number>();
  const seenPairs = new Set<string>();
  for (const row of snapshots) {
    if (row.job_id === null) continue;
    const t = new Date(row.capture_time).getTime();
    if (!firstCapture.has(row.job_id)) firstCapture.set(row.job_id, t);
    if (row.sku) {
      const key = row.sku.trim().toLowerCase();
      const pair = `sku:${key}:${row.job_id}`;
      if (!seenPairs.has(pair)) {
        seenPairs.add(pair);
        const list = bySku.get(key) ?? [];
        list.push(row.job_id);
        bySku.set(key, list);
      }
    }
    if (row.order_name) {
      const key = row.order_name.trim().toLowerCase();
      const pair = `order:${key}:${row.job_id}`;
      if (!seenPairs.has(pair)) {
        seenPairs.add(pair);
        const list = byOrderName.get(key) ?? [];
        list.push(row.job_id);
        byOrderName.set(key, list);
      }
    }
  }
  return { bySku, byOrderName, firstCapture };
}

type JobProductIndex = ReturnType<typeof buildJobProductIndex>;

function pickJobByTime(
  candidates: number[],
  firstCapture: Map<number, number>,
  startEpoch: number,
): number | null {
  let best: number | null = null;
  let bestAtOrAfter = Infinity;
  for (const id of candidates) {
    const fc = firstCapture.get(id) ?? Infinity;
    if (fc >= startEpoch && fc < bestAtOrAfter) {
      best = id;
      bestAtOrAfter = fc;
    }
  }
  if (best !== null) return best;
  let last: number | null = null;
  let lastBefore = -Infinity;
  for (const id of candidates) {
    const fc = firstCapture.get(id) ?? -Infinity;
    if (fc <= startEpoch && fc > lastBefore) {
      last = id;
      lastBefore = fc;
    }
  }
  return last;
}

function jobForEventResolved(
  e: DowntimeEvent,
  index: JobProductIndex,
  snapshots: JobSnapshotRow[],
): number | null {
  // OFS reports jobId 0 (not null) for spans with no usable job, so only a
  // positive id is authoritative — 0 must fall through to product/snapshot
  // matching like a missing id.
  if (e.job_id != null && e.job_id > 0) return e.job_id;
  let candidates: number[] = [];
  if (e.order_client_id) {
    candidates = index.bySku.get(e.order_client_id.trim().toLowerCase()) ?? [];
  }
  if (candidates.length === 0 && e.order) {
    candidates = index.byOrderName.get(e.order.trim().toLowerCase()) ?? [];
  }
  if (candidates.length > 0) {
    const byTime = pickJobByTime(candidates, index.firstCapture, e.start_epoch);
    if (byTime !== null) return byTime;
  }
  return jobForEvent(e, snapshots);
}

const ANALYTICS_PERSIST_KEY = 'ff_analytics_persist_v1';

interface AnalyticsPersistState {
  startAt: string;
  endAt: string;
  textFilter: string;
  typeFilters: string[];
  jobFilters: number[];
  loadedRange: { start: string; end: string } | null;
}

function defaultAnalyticsPersist(): AnalyticsPersistState {
  return {
    startAt: `${dateOffset(-6)}T00:00`,
    endAt: `${dateOffset(0)}T23:59`,
    textFilter: '',
    typeFilters: [],
    jobFilters: [],
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
      typeFilters: Array.isArray(parsed.typeFilters)
        ? parsed.typeFilters.filter((t): t is string => typeof t === 'string')
        : [],
      jobFilters: Array.isArray(parsed.jobFilters)
        ? parsed.jobFilters.filter((j): j is number => typeof j === 'number' && Number.isFinite(j))
        : [],
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
}

const BAR_COLORS = ['#1d4ed8', '#dc2626', '#eab308', '#16a34a', '#9333ea', '#0e7490', '#ea580c', '#64748b'];

function barColor(i: number): string {
  return BAR_COLORS[i % BAR_COLORS.length];
}

interface AnalyticsViewProps {
  syncTick?: number;
  userRole?: Role;
}

export function AnalyticsView({ syncTick = 0, userRole }: AnalyticsViewProps) {
  const [persisted] = useState(() => loadAnalyticsPersist());
  const [startAt, setStartAt] = useState(persisted.startAt);
  const [endAt, setEndAt] = useState(persisted.endAt);
  const [textFilter, setTextFilter] = useState(persisted.textFilter);
  const [typeFilters, setTypeFilters] = useState<string[]>(persisted.typeFilters);
  const [jobFilters, setJobFilters] = useState<number[]>(persisted.jobFilters);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [loadedRange, setLoadedRange] = useState<{ start: string; end: string } | null>(persisted.loadedRange);
  const [expandedDowntimeId, setExpandedDowntimeId] = useState<number | null>(null);
  const [overrides, setOverrides] = useState<Record<number, JobOverride>>({});
  const [latestRates, setLatestRates] = useState<Record<number, number>>({});
  const [editingJobId, setEditingJobId] = useState<number | null>(null);
  const [draftProduct, setDraftProduct] = useState('');
  const [draftSpeed, setDraftSpeed] = useState('');
  const [overrideSaving, setOverrideSaving] = useState(false);
  const [overrideError, setOverrideError] = useState<string | null>(null);
  const [aiSummary, setAiSummary] = useState<string | null>(null);
  const [aiMode, setAiMode] = useState<'brief' | 'detailed'>('brief');
  const [aiModel, setAiModel] = useState<AiModelId>('gemini-3.5-flash-lite');
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiCooldown, setAiCooldown] = useState(0);
  const [aiMessages, setAiMessages] = useState<ChatMessage[]>([]);
  const [aiChatInput, setAiChatInput] = useState('');
  const [aiChatLoading, setAiChatLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const cooldownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const summaryPayloadRef = useRef<AiSummaryPayload | null>(null);

  // Keep the Analytics filters and last loaded range in localStorage so the
  // page remembers them when the user navigates away and comes back.
  useEffect(() => {
    try {
      localStorage.setItem(ANALYTICS_PERSIST_KEY, JSON.stringify({ startAt, endAt, textFilter, typeFilters, jobFilters, loadedRange }));
    } catch {
      // ignore storage failures
    }
  }, [startAt, endAt, textFilter, typeFilters, jobFilters, loadedRange]);

  useEffect(() => {
    loadAiModel().then(setAiModel).catch(() => {});
  }, []);

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
    setAiSummary(null);
    setAiError(null);
    try {
      const startDay = start.slice(0, 10);
      const endDay = end.slice(0, 10);
      const [jobs, downtime, hourlyAll] = await Promise.all([
        fetchJobsInRange(start, end),
        fetchDowntimeBetween(start, end),
        fetchHourlySummaryByDate(startDay, endDay),
      ]);
      const hourly = hourlyAll.filter((h) => h.start >= sEpoch && h.start <= eEpoch);
      setData({ jobs, downtime, hourly });

      // User corrections (product name / rated speed) from the Live page or
      // Analytics edits, keyed by job so the jobs table can layer them on top
      // of the captured snapshot values.
      const jobIds = Array.from(new Set(jobs.map((j) => j.job_id).filter((id): id is number => id != null)));
      const ovrRows = await fetchOverridesForJobs(jobIds);
      const ovrMap: Record<number, JobOverride> = {};
      for (const o of ovrRows) ovrMap[o.job_id] = o;
      setOverrides(ovrMap);

      // Current rated speed per job (latest capture across all time, not just
      // the range) so the table reflects where each job stands today.
      const latestRates = await fetchLatestJobRates(jobIds);
      setLatestRates(latestRates);

      // If specific jobs are selected but don't appear in the new range, drop
      // them so the page doesn't keep an empty filter.
      setJobFilters((prev) => {
        const stillValid = prev.filter((id) => jobIds.includes(id));
        return stillValid.length === prev.length ? prev : stillValid;
      });

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

  const startEdit = (jobId: number) => {
    const j = jobs.find((x) => x.jobId === jobId);
    if (!j) return;
    setDraftProduct(j.product);
    setDraftSpeed(j.ratedSpeed > 0 ? String(j.ratedSpeed) : '');
    setEditingJobId(jobId);
    setOverrideError(null);
  };

  const handleSaveOverride = async (jobId: number) => {
    const speed = parseInt(draftSpeed, 10);
    if (!draftProduct.trim() || !Number.isFinite(speed) || speed <= 0) {
      setOverrideError('Enter a product name and a valid rated speed (cans per hour).');
      return;
    }
    setOverrideSaving(true);
    setOverrideError(null);
    try {
      await saveJobOverride(jobId, draftProduct.trim(), speed);
      setOverrides((prev) => ({
        ...prev,
        [jobId]: { job_id: jobId, product_name: draftProduct.trim(), rated_speed: speed },
      }));
      setEditingJobId(null);
      setMsg('Correction saved — applies across Live, Monitoring, and Analytics.');
    } catch (err) {
      setOverrideError(err instanceof Error ? err.message : 'Could not save the correction.');
    } finally {
      setOverrideSaving(false);
    }
  };

  const handleResetOverride = async (jobId: number) => {
    setOverrideSaving(true);
    setOverrideError(null);
    try {
      await deleteJobOverride(jobId);
      setOverrides((prev) => {
        const next = { ...prev };
        delete next[jobId];
        return next;
      });
      setEditingJobId(null);
      setMsg('Reset — back to the raw OFS values.');
    } catch (err) {
      setOverrideError(err instanceof Error ? err.message : 'Could not reset the correction.');
    } finally {
      setOverrideSaving(false);
    }
  };

  // Group job snapshots into one row per distinct OFS job, layering any user
  // correction (job_overrides) on top of the captured snapshot values.
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
      ratedSpeed: number;
      hasOverride: boolean;
      firstCapture: string;
      lastCapture: string;
      shifts: string[];
      runs: number;
    }[] = [];
    for (const [jobId, { rows }] of map) {
      const last = rows[rows.length - 1]!;
      const first = rows[0]!;
      const shifts = Array.from(new Set(rows.map((r) => r.shift_name).filter(Boolean))) as string[];
      const ovr = overrides[jobId];
      const ofsProduct = last.order_name ?? last.product_name ?? `Job ${jobId}`;
      list.push({
        jobId,
        product: ovr?.product_name?.trim() || ofsProduct,
        sku: last.sku ?? '',
        quantity: last.quantity ?? 0,
        produced: last.produced ?? 0,
        progressPct: last.progress_pct ?? 0,
        ratedSpeed: ovr?.rated_speed ?? (latestRates[jobId] ?? last.rated_speed ?? 0),
        hasOverride: !!ovr,
        firstCapture: first.capture_time,
        lastCapture: last.capture_time,
        shifts,
        runs: rows.length,
      });
    }
    list.sort((a, b) => a.jobId - b.jobId);
    return list;
  }, [data, overrides, latestRates]);

  // When one or more jobs are selected, the whole page (jobs, downtime, hourly
  // production, result cards, exports) narrows down to just those jobs.
  const visibleJobs = useMemo(
    () => (jobFilters.length === 0 ? jobs : jobs.filter((j) => jobFilters.includes(j.jobId))),
    [jobs, jobFilters],
  );

  const visibleHourly = useMemo(() => {
    if (!data) return [];
    if (jobFilters.length === 0) return data.hourly;
    return data.hourly.filter((h) => jobFilters.includes(activeJobForHour(h.start, data.jobs) ?? -1));
  }, [data, jobFilters]);

  // Which job (and therefore which rated speed) was running during each hour.
  // The job's rated speed is the fixed value from the Jobs table (e.g. 24000),
  // with any user correction applied. Hours with no job fall back to the OFS
  // per-hour rate.
  const hourJobRates = useMemo(() => {
    const rates: Record<number, number> = {};
    if (!data) return rates;
    const jobRate = new Map(jobs.map((j) => [j.jobId, j.ratedSpeed]));
    for (const h of data.hourly) {
      const jobId = activeJobForHour(h.start, data.jobs);
      if (jobId !== null && jobRate.has(jobId)) {
        rates[h.start] = jobRate.get(jobId)!;
      }
    }
    return rates;
  }, [data, jobs]);

  const downtime = useMemo(() => {
    if (!data) return [];
    let list = data.downtime;
    if (jobFilters.length > 0) {
      // Downtime events rarely carry a usable job id (OFS reports 0), so match
      // on the job the event belongs to (see jobForEventResolved).
      const productIndex = buildJobProductIndex(data.jobs);
      list = list.filter(
        (e) =>
          jobFilters.includes(e.job_id ?? -1) ||
          jobFilters.includes(jobForEventResolved(e, productIndex, data.jobs) ?? -1),
      );
    }
    if (typeFilters.length > 0) {
      list = list.filter((e) => typeFilters.includes(e.downtime_type ?? ''));
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
  }, [data, typeFilters, textFilter, jobFilters]);

  const downtimeTypes = useMemo(() => {
    if (!data) return [];
    return Array.from(new Set(data.downtime.map((e) => e.downtime_type).filter(Boolean))) as string[];
  }, [data]);

  const { totalDowntimeMs, downtimeCount, longestDowntimeMs, uptimePct, totalOut, avgEfficiency } = useMemo(() => {
    const totalDowntimeMs = downtime.reduce((sum, e) => sum + (e.duration_ms ?? 0), 0);
    const longestDowntimeMs = downtime.reduce((max, e) => Math.max(max, e.duration_ms ?? 0), 0);
    const days = loadedRange ? Math.max(1, Math.round((new Date(loadedRange.end).getTime() - new Date(loadedRange.start).getTime()) / 86400000) + 1) : 1;
    const uptimePct = Math.max(0, Math.min(100, 100 - (totalDowntimeMs / (days * 86400000)) * 100));
    const totalOut = visibleHourly.reduce((sum, h) => sum + h.in, 0);
    let effSum = 0;
    let effCount = 0;
    for (const h of visibleHourly) {
      const rated = hourJobRates[h.start] ?? h.rated;
      if (rated > 0) {
        effSum += (h.in / rated) * 100;
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
  }, [downtime, loadedRange, hourJobRates, visibleHourly]);

  const maxHourOut = useMemo(
    () => visibleHourly.reduce((m, h) => Math.max(m, h.out), 0),
    [visibleHourly],
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
    return visibleHourly.map((h) => {
      const datePart = h.startText ? h.startText.slice(0, 10) : '';
      const dateShort = datePart ? `${datePart.slice(8, 10)}/${datePart.slice(5, 7)}` : '';
      return dateShort ? `${dateShort} ${h.hour}` : h.hour;
    });
  }, [visibleHourly]);

  const handleExportAll = () => {
    if (!data) return;
    const rows: (string | number | null | undefined)[][] = [];
    rows.push(['SECTION', 'JOBS']);
    rows.push(['Job', 'Product', 'SKU', 'Rated Speed', 'Target', 'Produced', 'Progress %', 'First Capture', 'Last Capture', 'Runs']);
    for (const j of visibleJobs) {
      rows.push([`Job ${j.jobId}`, j.product, j.sku, j.ratedSpeed, j.quantity, j.produced, j.progressPct.toFixed(1), aucklandTime(j.firstCapture), aucklandTime(j.lastCapture), j.runs]);
    }
    rows.push(['SECTION', 'DOWNTIME']);
    rows.push(['Start', 'Duration (ms)', 'Duration', 'Type', 'Category', 'Reason', 'Crew', 'Status']);
    for (const e of downtime) {
      rows.push([eventStartLabel(e), e.duration_ms, eventDuration(e), e.downtime_type, e.category, e.reason, e.crew_name, e.resolved ? 'Resolved' : 'Ongoing']);
    }
    rows.push(['SECTION', 'HOURLY PRODUCTION']);
    rows.push(['Date', 'Hour', 'In', 'Out', 'Rated']);
    for (const h of visibleHourly) {
      const datePart = h.startText ? h.startText.slice(0, 10) : '';
      rows.push([datePart, h.hour, h.in, h.out, hourJobRates[h.start] ?? h.rated]);
    }
    downloadCsv(`analytics_${loadedRange?.start}_to_${loadedRange?.end}.csv`, ['Analytics Export'], rows);
    setMsg('CSV exported');
  };

  const startCooldown = useCallback((seconds: number) => {
    setAiCooldown(seconds);
    if (cooldownRef.current) clearInterval(cooldownRef.current);
    cooldownRef.current = setInterval(() => {
      setAiCooldown((prev) => {
        if (prev <= 1) {
          if (cooldownRef.current) clearInterval(cooldownRef.current);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }, []);

  const buildPayload = useCallback((): AiSummaryPayload | null => {
    if (!data || !loadedRange) return null;
    const typeMap = new Map<string, { ms: number; count: number }>();
    for (const e of downtime) {
      const t = e.downtime_type ?? 'UNKNOWN';
      const entry = typeMap.get(t) ?? { ms: 0, count: 0 };
      entry.ms += e.duration_ms ?? 0;
      entry.count += 1;
      typeMap.set(t, entry);
    }
    const downtimeByType = Array.from(typeMap.entries())
      .map(([type, { ms, count }]) => ({ type, ms, count }));
    const hourlyProduction = visibleHourly.map((h) => ({
      hour: h.startText ? h.startText.slice(0, 16).replace('T', ' ') : h.hour,
      in: h.in, out: h.out, rated: hourJobRates[h.start] ?? h.rated,
    }));
    const jobs = visibleJobs.map((j) => ({
      jobId: j.jobId, product: j.product, ratedSpeed: j.ratedSpeed,
      target: j.quantity, produced: j.produced, progressPct: j.progressPct,
    }));
    const topDowntimeEvents = [...downtime]
      .sort((a, b) => (b.duration_ms ?? 0) - (a.duration_ms ?? 0))
      .slice(0, 10)
      .map((e) => ({
        durationMs: e.duration_ms ?? 0,
        type: e.downtime_type ?? 'UNKNOWN',
        category: e.category ?? e.reason ?? 'Unknown',
        reason: e.reason ?? '',
        comments: (e.comments ?? [])
          .filter((c) => !c.systemPost)
          .map((c) => ({ author: c.userName, text: c.text })),
      }));
    return {
      model: aiModel, mode: aiMode, rangeStart: loadedRange.start.replace('T', ' '),
      rangeEnd: loadedRange.end.replace('T', ' '),
      totalDowntimeMs, downtimeCount, longestDowntimeMs, uptimePct,
      totalOut, avgEfficiency, jobs, downtimeByType, downtimeByCategory,
      hourlyProduction, topDowntimeEvents,
    };
  }, [data, loadedRange, downtime, visibleJobs, visibleHourly, hourJobRates, totalDowntimeMs, downtimeCount, longestDowntimeMs, uptimePct, totalOut, avgEfficiency, downtimeByCategory, aiMode, aiModel]);

  const handleAiSummary = useCallback(async (newMode: 'brief' | 'detailed') => {
    if (!data || !loadedRange) return;
    if (aiCooldown > 0) return;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setAiMode(newMode);
    setAiLoading(true);
    setAiError(null);
    setAiSummary(null);
    setAiMessages([]);
    try {
      const payload = buildPayload();
      if (!payload) return;
      payload.mode = newMode;
      summaryPayloadRef.current = payload;
      let text = '';
      for await (const chunk of fetchAiSummaryStream(payload)) {
        if (ctrl.signal.aborted) break;
        text += chunk;
        setAiSummary(text);
      }
      if (!ctrl.signal.aborted) startCooldown(5);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to generate summary';
      if (!ctrl.signal.aborted) setAiError(msg);
      if (msg.includes('429') || msg.includes('Rate limited')) startCooldown(60);
    } finally {
      if (!ctrl.signal.aborted) setAiLoading(false);
    }
  }, [data, loadedRange, aiCooldown, buildPayload, startCooldown]);

  const handleAiChat = useCallback(async () => {
    const payload = summaryPayloadRef.current;
    if (!payload || !aiChatInput.trim()) return;
    if (aiCooldown > 0 || aiChatLoading) return;
    const userMsg = aiChatInput.trim();
    setAiChatInput('');
    setAiChatLoading(true);
    setAiError(null);
    const newMessages: ChatMessage[] = [...aiMessages, { role: 'user', content: userMsg }];
    setAiMessages(newMessages);
    setAiMessages([...newMessages, { role: 'model', content: '' }]);
    try {
      let reply = '';
      for await (const chunk of sendAiChatMessage(payload, aiMessages, userMsg)) {
        reply += chunk;
        setAiMessages([...newMessages, { role: 'model', content: reply }]);
      }
      startCooldown(3);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Chat failed';
      setAiError(msg);
      if (msg.includes('429') || msg.includes('Rate limited')) startCooldown(60);
    } finally {
      setAiChatLoading(false);
    }
  }, [aiChatInput, aiMessages, aiCooldown, aiChatLoading, startCooldown]);

  const handleCopySummary = useCallback(async () => {
    if (!aiSummary) return;
    const header = `AI Summary — ${loadedRange?.start ?? ''} to ${loadedRange?.end ?? ''}\nMode: ${aiMode}\n\n`;
    await copySummaryToClipboard(header + aiSummary);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [aiSummary, loadedRange, aiMode]);

  const handleDownloadSummary = useCallback(() => {
    if (!aiSummary) return;
    const header = `AI Summary — ${loadedRange?.start ?? ''} to ${loadedRange?.end ?? ''}\nMode: ${aiMode}\n\n`;
    const label = loadedRange ? `${loadedRange.start}_to_${loadedRange.end}` : 'summary';
    downloadSummaryTxt(header + aiSummary, label);
  }, [aiSummary, loadedRange, aiMode]);

  const isLoading = loading;
  const hasData = !!data;

  return (
    <div>
      <PageHelp
        title="Analytics"
        intro="Review captured data across any date range: downtime events, active jobs, and hourly production — with charts and CSV exports for further analysis."
        sections={[
          {
            title: "Selecting a range",
            items: [
              "Choose a start and end date and time, then click Load Data. Quick buttons (Today, 7 Days, 14 Days, 30 Days) set common ranges instantly.",
              "The range uses the factory console clock, so overnight shifts and UTC timestamps are aligned to the line's local date and time.",
              "The selected date/time window applies to jobs, downtime events, and hourly production.",
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
              "Export All downloads jobs, downtime, and hourly production in one CSV file.",
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
          <div style={{ marginTop: 8, fontSize: 12, fontWeight: 600, color: 'var(--blue-tag-text)' }}>
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
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 8, padding: 24, fontSize: 13, fontWeight: 600, color: 'var(--text-faint)' }}>
          <Loader2 size={16} className="animate-spin" /> Loading analytics data…
        </div>
      )}

      {hasData && !isLoading && (
        <>
          <div className="card-row" style={{ justifyContent: 'flex-start', flexWrap: 'wrap', gap: 10, marginBottom: 4 }}>
            <button type="button" className="tab-btn tab-btn-blue" onClick={handleExportAll}>
              <FileDown size={14} /> Export All CSV
            </button>
            <CheckboxDropdown
              label="Jobs"
              options={jobs.map((j) => ({ value: String(j.jobId), label: `Job ${j.jobId} — ${j.product}` }))}
              selected={jobFilters.map(String)}
              onChange={(values) => setJobFilters(values.map(Number))}
            />
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 15 }}>
            <div className="card card-blue">
              <div className="card-row stat-row"><span>Total Downtime:</span><span className="card-value">{formatDuration(totalDowntimeMs)}</span></div>
            </div>
            <div className="card card-blue">
              <div className="card-row stat-row"><span>Downtime Events:</span><span className="card-value">{downtimeCount.toLocaleString()}</span></div>
            </div>
            <div className="card card-green">
              <div className="card-row stat-row"><span>Total Output:</span><span className="card-value">{totalOut.toLocaleString()}</span></div>
            </div>
            <div className="card card-green">
              <div className="card-row stat-row"><span>Avg Efficiency:</span><span className="card-value">{avgEfficiency.toFixed(2)}%</span></div>
            </div>
            <div className="card card-teal">
              <div className="card-row stat-row"><span>Distinct Jobs:</span><span className="card-value">{visibleJobs.length}</span></div>
            </div>
            <div className="card card-teal">
              <div className="card-row stat-row"><span>Longest Downtime:</span><span className="card-value">{formatDuration(longestDowntimeMs)}</span></div>
            </div>
            <div className="card card-teal">
              <div className="card-row stat-row"><span>Uptime (est.):</span><span className="card-value">{uptimePct.toFixed(1)}%</span></div>
            </div>
          </div>

          {/* AI Summary — admin only */}
          {userRole === 'admin' && (
          <div className="card card-purple">
            <h3 style={{ display: 'flex', alignItems: 'center', gap: 6, margin: 0, paddingBottom: 8, borderBottom: '1px solid currentColor' }}>
              <Sparkles size={16} style={{ opacity: 0.7 }} />
              <span style={{ fontSize: 14, fontWeight: 700 }}>AI Summary</span>
              <select
                className="ai-model-select"
                value={aiModel}
                onChange={(e) => { const v = e.target.value as AiModelId; setAiModel(v); saveAiModel(v).catch(() => {}); }}
                style={{ marginLeft: 'auto' }}
              >
                {AI_MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
            </h3>

            {!aiSummary && !aiLoading && !aiError && (
              <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12, fontWeight: 600 }}>
                  {aiCooldown > 0 ? `Wait ${aiCooldown}s...` : 'Generate a summary for this data range:'}
                </span>
                <button type="button" className="tab-btn tab-btn-purple" onClick={() => handleAiSummary('brief')} disabled={aiLoading || aiCooldown > 0}>
                  Brief
                </button>
                <button type="button" className="tab-btn tab-btn-purple" style={{ opacity: 0.85 }} onClick={() => handleAiSummary('detailed')} disabled={aiLoading || aiCooldown > 0}>
                  Detailed
                </button>
              </div>
            )}

            {aiLoading && (
              <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 600 }}>
                <Loader2 size={14} className="animate-spin" />
                Generating {aiMode} summary...
                {aiSummary && <span style={{ opacity: 0.6, fontWeight: 400 }}>(streaming)</span>}
              </div>
            )}

            {aiError && (
              <div className="ai-error" style={{ marginTop: 10, padding: '8px 12px', borderRadius: 6, background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', fontSize: 12, fontWeight: 600 }}>
                {aiError}
                {aiCooldown > 0 && <span style={{ marginLeft: 8, opacity: 0.7 }}>({aiCooldown}s)</span>}
                <button type="button" style={{ marginLeft: 10, background: 'none', border: 'none', color: 'inherit', textDecoration: 'underline', cursor: 'pointer', fontSize: 12, fontWeight: 600 }} onClick={() => { setAiError(null); setAiSummary(null); }}>Dismiss</button>
              </div>
            )}

            {aiSummary && (
              <>
                <div style={{ marginTop: 10, whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.65 }}>
                  {aiSummary}
                  {aiLoading && <span className="animate-pulse" style={{ display: 'inline-block', width: 6, height: 14, backgroundColor: '#7c3aed', marginLeft: 2, borderRadius: 2, verticalAlign: 'text-bottom' }} />}
                </div>

                {/* Action buttons */}
                <div style={{ marginTop: 10, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  <button type="button" className="tab-btn tab-btn-purple" onClick={() => handleAiSummary(aiMode)} disabled={aiLoading || aiCooldown > 0}>
                    <RefreshCw size={11} style={{ marginRight: 4 }} /> {aiCooldown > 0 ? `Retry in ${aiCooldown}s` : 'Regenerate'}
                  </button>
                  <button type="button" className="tab-btn tab-btn-purple-outline" onClick={() => handleAiSummary(aiMode === 'brief' ? 'detailed' : 'brief')} disabled={aiLoading || aiCooldown > 0}>
                    Switch to {aiMode === 'brief' ? 'Detailed' : 'Brief'}
                  </button>
                  <button type="button" className="tab-btn tab-btn-purple-outline" onClick={handleCopySummary} disabled={aiLoading}>
                    {copied ? <><Check size={11} style={{ marginRight: 4 }} /> Copied</> : <><Copy size={11} style={{ marginRight: 4 }} /> Copy</>}
                  </button>
                  <button type="button" className="tab-btn tab-btn-purple-outline" onClick={handleDownloadSummary} disabled={aiLoading}>
                    <Download size={11} style={{ marginRight: 4 }} /> Download
                  </button>
                </div>

                {/* Chat follow-up */}
                <div style={{ marginTop: 14, borderTop: '1px solid currentColor', paddingTop: 10 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.3px', opacity: 0.6, marginBottom: 6 }}>Follow-up questions</div>
                  {aiMessages.length > 0 && (
                    <div style={{ maxHeight: 200, overflowY: 'auto', marginBottom: 8 }}>
                      {aiMessages.map((m, i) => (
                        <div key={i} style={{ fontSize: 12, marginBottom: 4, padding: '4px 8px', borderRadius: 6, backgroundColor: m.role === 'user' ? 'rgba(124,58,237,0.1)' : 'rgba(124,58,237,0.05)', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>
                          <span style={{ fontWeight: 700, opacity: 0.5, fontSize: 10 }}>{m.role === 'user' ? 'You' : 'AI'}</span>
                          <span style={{ whiteSpace: 'pre-wrap' }}>{m.content || '...'}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input
                      type="text"
                      value={aiChatInput}
                      onChange={(e) => setAiChatInput(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleAiChat(); } }}
                      placeholder="e.g. What caused the most downtime on Tuesday?"
                      disabled={aiChatLoading || aiCooldown > 0}
                      style={{ flex: 1, fontSize: 12, padding: '6px 10px', borderRadius: 6, border: '1px solid rgba(124,58,237,0.3)', backgroundColor: 'rgba(255,255,255,0.5)', color: 'inherit', outline: 'none' }}
                    />
                    <button type="button" className="tab-btn tab-btn-purple" onClick={handleAiChat} disabled={aiChatLoading || aiCooldown > 0 || !aiChatInput.trim()} style={{ padding: '6px 12px' }}>
                      {aiChatLoading ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
          )}

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
                    ['Job', 'Product', 'SKU', 'Rated Speed', 'Target', 'Produced', 'Progress %', 'First Capture', 'Last Capture', 'Shifts', 'Runs'],
                    visibleJobs.map((j) => [`Job ${j.jobId}`, j.product, j.sku, j.ratedSpeed, j.quantity, j.produced, j.progressPct.toFixed(1), aucklandTime(j.firstCapture), aucklandTime(j.lastCapture), j.shifts.join(' | '), j.runs]),
                  );
                  setMsg('Jobs CSV exported');
                }}
              >
                <FileDown size={12} /> CSV
              </button>
            </h3>
            {visibleJobs.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 500, padding: 8 }}>
                No jobs captured in this range.
              </div>
            ) : (
              <div className="card-scroll">
                <table className="w-full text-[13px]" style={{ minWidth: 860 }}>
                  <thead>
                    <tr className="text-left text-[11px] font-bold uppercase tracking-wide text-slate-800 border-b border-slate-200">
                      <th className="px-4 py-2.5">Job</th>
                      <th className="px-4 py-2.5">SKU</th>
                      <th className="px-4 py-2.5">Rated Speed</th>
                      <th className="px-4 py-2.5">Target</th>
                      <th className="px-4 py-2.5">Produced</th>
                      <th className="px-4 py-2.5">Progress</th>
                      <th className="px-4 py-2.5">First / Last Capture</th>
                      <th className="px-4 py-2.5">Shifts</th>
                      <th className="px-4 py-2.5">Snapshots</th>
                      <th className="px-4 py-2.5">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleJobs.map((j) => {
                      const isEditing = editingJobId === j.jobId;
                      return (
                        <tr key={j.jobId} className="border-b border-slate-100 hover:bg-slate-50 transition-colors">
                          <td className="px-4 py-3 text-slate-700">
                            <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--blue-tag-text)', backgroundColor: 'var(--blue-tag-bg)', border: '1px solid var(--blue-tag-border)', borderRadius: 999, padding: '2px 8px', whiteSpace: 'nowrap' }}>
                              Job {j.jobId}
                            </span>
                            {isEditing ? (
                              <input
                                type="text"
                                value={draftProduct}
                                onChange={(e) => setDraftProduct(e.target.value)}
                                disabled={overrideSaving}
                                aria-label={`Product name for job ${j.jobId}`}
                                style={{ display: 'block', width: '100%', marginTop: 4, fontSize: 13, fontWeight: 600, padding: '3px 8px', borderRadius: 6, border: '1px solid var(--input-border)', backgroundColor: 'var(--input-bg)', color: 'var(--input-text)', maxWidth: 240 }}
                              />
                            ) : (
                              <div style={{ fontSize: 12, marginTop: 4, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                                {j.product}
                                {j.hasOverride && (
                                  <span style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.3px', color: 'var(--blue-tag-text)', backgroundColor: 'var(--blue-tag-bg)', border: '1px solid var(--blue-tag-border)', borderRadius: 999, padding: '1px 6px', whiteSpace: 'nowrap' }}>
                                    Corrected
                                  </span>
                                )}
                              </div>
                            )}
                          </td>
                          <td className="px-4 py-3 text-slate-600">{j.sku || '-'}</td>
                          <td className="px-4 py-3 text-slate-600">
                            {isEditing ? (
                              <input
                                type="number"
                                min="1"
                                value={draftSpeed}
                                onChange={(e) => setDraftSpeed(e.target.value)}
                                disabled={overrideSaving}
                                aria-label={`Rated speed for job ${j.jobId}`}
                                style={{ width: 120, fontSize: 13, padding: '3px 8px', borderRadius: 6, border: '1px solid var(--input-border)', backgroundColor: 'var(--input-bg)', color: 'var(--input-text)' }}
                              />
                            ) : (
                              j.ratedSpeed > 0 ? `${j.ratedSpeed.toLocaleString()} /hr` : '-'
                            )}
                          </td>
                          <td className="px-4 py-3 text-slate-600">{j.quantity.toLocaleString()}</td>
                          <td className="px-4 py-3 text-slate-600">{j.produced.toLocaleString()}</td>
                          <td className="px-4 py-3 text-slate-700">
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <div style={{ width: 80, height: 8, backgroundColor: 'var(--track-bg)', borderRadius: 999, overflow: 'hidden' }}>
                                <div style={{ width: `${Math.min(100, Math.max(0, j.progressPct))}%`, height: '100%', backgroundColor: j.progressPct >= 100 ? '#16a34a' : '#1d4ed8' }} />
                              </div>
                              <span>{j.progressPct.toFixed(1)}%</span>
                            </div>
                          </td>
                          <td className="px-4 py-3 text-slate-600 whitespace-nowrap">
                            <div style={{ fontSize: 12 }}>{aucklandTime(j.firstCapture)}</div>
                            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{aucklandTime(j.lastCapture)}</div>
                          </td>
                          <td className="px-4 py-3 text-slate-600">{j.shifts.length > 0 ? j.shifts.join(', ') : '-'}</td>
                          <td className="px-4 py-3 text-slate-600">{j.runs}</td>
                          <td className="px-4 py-3">
                            {isEditing ? (
                              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                                <button
                                  type="button"
                                  onClick={() => handleSaveOverride(j.jobId)}
                                  disabled={overrideSaving}
                                  style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 8px', fontSize: 11, fontWeight: 700, color: '#fff', backgroundColor: '#1d4ed8', border: 'none', borderRadius: 6, cursor: 'pointer' }}
                                >
                                  {overrideSaving ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />}
                                  Save
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setEditingJobId(null)}
                                  disabled={overrideSaving}
                                  style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 8px', fontSize: 11, fontWeight: 700, color: '#1d4ed8', backgroundColor: 'transparent', border: '1px solid #1d4ed8', borderRadius: 6, cursor: 'pointer' }}
                                >
                                  <X size={11} />
                                  Cancel
                                </button>
                                {j.hasOverride && (
                                  <button
                                    type="button"
                                    onClick={() => handleResetOverride(j.jobId)}
                                    disabled={overrideSaving}
                                    style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 8px', fontSize: 11, fontWeight: 700, color: '#1d4ed8', backgroundColor: 'transparent', border: '1px solid #1d4ed8', borderRadius: 6, cursor: 'pointer' }}
                                  >
                                    <RotateCcw size={11} />
                                    Reset
                                  </button>
                                )}
                              </div>
                            ) : (
                              <button
                                type="button"
                                onClick={() => startEdit(j.jobId)}
                                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 8px', fontSize: 11, fontWeight: 700, color: '#1d4ed8', backgroundColor: 'transparent', border: '1px solid #1d4ed8', borderRadius: 6, cursor: 'pointer' }}
                              >
                                <Pencil size={11} />
                                Edit
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {overrideError && (
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, margin: 8, padding: 8, borderRadius: 6, border: '1px solid var(--danger-border, #fecaca)', backgroundColor: 'var(--danger-bg, #fef2f2)', color: 'var(--danger-text)', fontSize: 12, fontWeight: 600 }}>
                    <AlertTriangle size={13} style={{ marginTop: 1, flexShrink: 0 }} />
                    <span>{overrideError}</span>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Job progress chart */}
          {visibleJobs.length > 0 && (
            <div className="card card-blue">
              <h3>Job Progress</h3>
              <div className="card-scroll-sm" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {visibleJobs.map((j, i) => (
                  <div key={j.jobId}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, fontWeight: 600, marginBottom: 2 }}>
                      <span>Job {j.jobId} — {j.product}</span>
                      <span>{j.progressPct.toFixed(1)}%</span>
                    </div>
                    <div style={{ width: '100%', height: 12, backgroundColor: 'var(--track-bg)', borderRadius: 6, overflow: 'hidden' }}>
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
                  style={{ fontSize: 12, padding: '4px 8px', borderRadius: 6, border: '1px solid var(--input-border)', backgroundColor: 'var(--input-bg)', color: 'var(--input-text)', maxWidth: 160 }}
                />
                <CheckboxDropdown
                  label="Type"
                  options={downtimeTypes.map((t) => ({ value: t, label: t }))}
                  selected={typeFilters}
                  onChange={setTypeFilters}
                />
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
              <div style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 500, padding: 8 }}>
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
                      <th className="px-4 py-2.5 text-center">Edit</th>
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
                            <td className="px-4 py-3 text-slate-700 whitespace-nowrap">
                              <span className="inline-flex items-center gap-1.5">
                                {eventDuration(e)}
                                {e.user_edited && (
                                  <span
                                    className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-brand-100 text-brand-800 text-[10px] font-bold"
                                    title="Duration corrected manually"
                                  >
                                    <Check size={10} /> Edited
                                  </span>
                                )}
                              </span>
                            </td>
                            <td className="px-4 py-3">
                              <DowntimeTypeBadge type={e.downtime_type} />
                            </td>
                            <td className="px-4 py-3 text-slate-600">{e.category ?? '-'}</td>
                            <td className="px-4 py-3 text-slate-700" style={{ maxWidth: 260 }}>{e.reason ?? '-'}</td>
                            <td className="px-4 py-3 text-slate-600">{e.crew_name ?? '-'}</td>
                            <td className="px-4 py-3">
                              <span style={{ fontSize: 11, fontWeight: 700, color: e.resolved ? 'var(--success-text)' : 'var(--danger-text)' }}>
                                {e.resolved ? 'Resolved' : 'Ongoing'}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-center">
                              <DowntimeEventEdit event={e} onSaved={() => loadData(startAt, endAt)} />
                            </td>
                          </tr>
                          {isExpanded && hasComments && (
                            <tr className="border-b border-slate-100 bg-slate-50/50">
                              <td colSpan={8} className="px-4 py-3">
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
                    <div style={{ width: '100%', height: 12, backgroundColor: 'var(--track-bg)', borderRadius: 6, overflow: 'hidden' }}>
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
                    visibleHourly.map((h) => [h.startText ? h.startText.slice(0, 10) : '', h.hour, h.in, h.out, hourJobRates[h.start] ?? h.rated]),
                  );
                  setMsg('Hourly CSV exported');
                }}
              >
                <FileDown size={12} /> CSV
              </button>
            </h3>
            {visibleHourly.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 500, padding: 8 }}>
                No hourly data available for this range.
              </div>
            ) : (
              <>
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 120, overflowX: 'auto', paddingBottom: 4 }}>
                  {visibleHourly.map((h, i) => (
                    <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', height: '100%', minWidth: 34, flexShrink: 0 }}>
                      <div
                        title={`${hourLabels[i] ?? h.hour}: ${h.out.toLocaleString()}`}
                        style={{
                          width: 22,
                          height: `${maxHourOut > 0 ? Math.max(2, (h.out / maxHourOut) * 100) : 2}%`,
                          backgroundColor: h.out > 0 ? '#16a34a' : 'var(--track-bg)',
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
                      {visibleHourly.map((h, i) => {
                        const rated = hourJobRates[h.start] ?? h.rated;
                        const eff = rated > 0 ? ((h.in / rated) * 100).toFixed(2) : '0.00';
                        return (
                          <tr key={i} className="border-b border-slate-100 hover:bg-slate-50 transition-colors">
                            <td className="px-4 py-3 text-slate-600">{h.startText ? h.startText.slice(0, 10) : '-'}</td>
                            <td className="px-4 py-3 text-slate-700">{h.hour}</td>
                            <td className="px-4 py-3 text-slate-600">{h.in.toLocaleString()}</td>
                            <td className="px-4 py-3 text-slate-700">{h.out.toLocaleString()}</td>
                            <td className="px-4 py-3 text-slate-600">{rated.toLocaleString()}</td>
                            <td className="px-4 py-3" style={{ color: rated > 0 && (h.in / rated) >= 0.7 ? 'var(--success-text)' : 'var(--danger-text)', fontWeight: 700 }}>{eff}%</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>

        </>
      )}

      {msg && (
        <div style={{ textAlign: 'center', marginTop: 10, fontSize: 12, fontWeight: 600, color: 'var(--success-text)' }}>
          {msg}
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
            <p className="m-0 mt-0.5 text-slate-700">{c.text}</p>
          </div>
        </div>
      ))}
    </div>
  );
}
