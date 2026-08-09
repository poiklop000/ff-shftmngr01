import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Clock,
  Gauge,
  Loader2,
  Package,
  TrendingUp,
  User as UserIcon,
} from 'lucide-react';
import { loadLiveIntervals } from '@/lib/liveConfig';
import {
  classifyLineState,
  fetchOfsStatus,
  LINE_STATE_COLORS,
  type LineStateClass,
  type OfsLiveStatus,
  type OfsRunState,
} from '@/lib/ofs';
import { loadJobOverride, type JobOverride } from '@/lib/jobOverrides';
import { fetchHourlySummaryByDate, type HourlySummaryEntry } from '@/lib/counterLogs';
import { fetchDowntimeForShift, downtimeEventEndText, type DowntimeEvent } from '@/lib/downtime';
import { fetchHourlyRatedSpeeds } from '@/lib/jobSnapshots';
import {
  computeDowntimeLogs,
  filterByShiftWindow,
  getActiveHours,
  parseNumber,
  SHIFT_LABELS,
  SHIFT_LIST,
  type Shift,
  type ShiftRow,
} from '@/types';
import { DowntimeTimeline } from '@/components/DowntimeTimeline';
import { ShiftTable } from '@/components/ShiftTable';

const DEFAULT_LIVE_MS = 3000;
const DEFAULT_SUMMARY_MS = 30000;
const TABLE_ROTATE_MS = 20000;
const VIEW_ROTATE_MS = 20000;

interface BoardViewProps {
  transitionMs?: number;
}

function dateToStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function nextDateStr(date: string): string {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + 1);
  return dateToStr(d);
}

function timeStrToMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

// Converts an "HH:MM" time to minutes-of-shift-day, rolling times before the
// shift start forward by 1440 (e.g. "00:30" during an 18:00 shift becomes
// minute 1470). Mirrors the private helper in types.ts.
function shiftTimeToMinutes(time: string, shiftStartMin: number): number {
  const min = timeStrToMinutes(time);
  return min < shiftStartMin ? min + 1440 : min;
}

// The board has no global date/shift controls, so it works out its own shift
// window from the live OFS status: the shift type reported by the console when
// it matches one of the app's shifts, otherwise a time-of-day guess. The date
// comes from the console's shift start, so overnight shifts (e.g. Night
// starting 18:00) point at the correct starting calendar day.
function detectShiftContext(status: OfsLiveStatus | null): { shift: Shift; date: string } {
  const consoleTime = status?.workcentre?.consoletimeText || status?.timestampText || '';
  const shiftType = status?.shift?.type;
  let shift: Shift = 'Morning';
  if (shiftType && (SHIFT_LIST as string[]).includes(shiftType)) {
    shift = shiftType as Shift;
  } else {
    const match = consoleTime.match(/(\d{1,2}):(\d{2})/);
    const hour = match ? parseInt(match[1], 10) : 6;
    shift = hour >= 18 || hour < 6 ? 'Night' : 'Morning';
  }
  if (shift === 'Custom') shift = 'Morning';

  const shiftStartDate = status?.shift?.startText?.slice(0, 10);
  const consoleDate = consoleTime.match(/^(\d{4}-\d{2}-\d{2})/)?.[1];
  const date =
    shiftStartDate && /^\d{4}-\d{2}-\d{2}$/.test(shiftStartDate)
      ? shiftStartDate
      : consoleDate && /^\d{4}-\d{2}-\d{2}$/.test(consoleDate)
        ? consoleDate
        : dateToStr(new Date());
  return { shift, date };
}

function isOvernightShift(shift: Shift): boolean {
  const hours = getActiveHours(shift, []);
  const startStr = hours[0]?.split(' - ')[0]?.trim();
  return startStr ? parseInt(startStr.split(':')[0], 10) >= 12 : false;
}

export function BoardView({ transitionMs = VIEW_ROTATE_MS }: BoardViewProps) {
  const [status, setStatus] = useState<OfsLiveStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorTimedOut, setErrorTimedOut] = useState(false);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [liveRefreshMs, setLiveRefreshMs] = useState(DEFAULT_LIVE_MS);
  const [summaryRefreshMs, setSummaryRefreshMs] = useState(DEFAULT_SUMMARY_MS);
  const [summary, setSummary] = useState<HourlySummaryEntry[]>([]);
  const [ratedSpeeds, setRatedSpeeds] = useState<Record<number, number>>({});
  const [downtimeEvents, setDowntimeEvents] = useState<DowntimeEvent[]>([]);
  const [boardLoading, setBoardLoading] = useState(false);
  const [override, setOverride] = useState<JobOverride | null>(null);
  const [now, setNow] = useState(Date.now());
  const [page, setPage] = useState(0);
  const [switchAt, setSwitchAt] = useState(Date.now() + TABLE_ROTATE_MS);
  const [rowsPerPage, setRowsPerPage] = useState<number | null>(null);
  const [mainView, setMainView] = useState<'status' | 'table'>('status');
  const [viewSwitchAt, setViewSwitchAt] = useState(Date.now() + transitionMs);
  const tableCardRef = useRef<HTMLDivElement>(null);
  const tableWrapRef = useRef<HTMLDivElement>(null);
  const tableFootRef = useRef<HTMLParagraphElement>(null);
  const rowHeightRef = useRef(0);

  // Live clock tick so the State Time counter keeps counting up on screen.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const load = useCallback(async () => {
    try {
      const data = await fetchOfsStatus();
      setStatus(data);
      setError(null);
      setLastUpdated(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load line status');
      setErrorTimedOut(err instanceof Error && err.name === 'AbortError');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    let mounted = true;
    loadLiveIntervals()
      .then((intervals) => {
        if (!mounted) return;
        setLiveRefreshMs(intervals.liveMs);
        setSummaryRefreshMs(intervals.summaryMs);
      })
      .catch(() => {});
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    const id = setInterval(load, liveRefreshMs);
    return () => clearInterval(id);
  }, [load, liveRefreshMs]);

  const { shift, date } = useMemo(() => detectShiftContext(status), [status]);

  // Board data (hourly counts, rated speeds, downtime) reloads whenever the
  // detected shift window changes (e.g. at a shift boundary) or on the summary
  // interval, so the table and timeline stay live without any manual controls.
  useEffect(() => {
    if (!date) return;
    let cancelled = false;

    const loadBoard = async () => {
      setBoardLoading(true);
      try {
        const hours = getActiveHours(shift, []);
        if (hours.length === 0) return;
        const day = await fetchHourlySummaryByDate(date);
        if (isOvernightShift(shift)) {
          day.push(...(await fetchHourlySummaryByDate(nextDateStr(date))));
        }
        const rated = await fetchHourlyRatedSpeeds(date, shift, []);
        const events = await fetchDowntimeForShift(shift, [], date);
        if (cancelled) return;
        setSummary(day);
        setRatedSpeeds(rated);
        setDowntimeEvents(events);
      } catch {
        // keep the last known data on the board if a refresh fails
      } finally {
        if (!cancelled) setBoardLoading(false);
      }
    };

    loadBoard();
    const timer = window.setInterval(loadBoard, summaryRefreshMs);
    return () => {
      cancelled = true;
      if (timer) window.clearInterval(timer);
    };
  }, [shift, date, summaryRefreshMs]);

  const job = status?.job;
  const jobId = job?.id ?? null;

  useEffect(() => {
    let cancelled = false;
    setOverride(null);
    if (jobId == null) return;
    loadJobOverride(jobId)
      .then((o) => {
        if (!cancelled) setOverride(o);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [jobId]);

  const activeHours = useMemo(() => getActiveHours(shift, []), [shift]);

  // Adaptive paging: measure how many table rows fit the card's visible area
  // and rotate through pages so no row is hidden by scrolling.
  useEffect(() => {
    const card = tableCardRef.current;
    const wrap = tableWrapRef.current;
    const foot = tableFootRef.current;
    if (!card || !wrap || !foot) return;

    const measure = () => {
      const totalRows = activeHours.length;
      if (totalRows <= 0) return;
      if (rowHeightRef.current <= 0 && wrap.offsetHeight > 0) {
        rowHeightRef.current = wrap.offsetHeight / totalRows;
      }
      if (rowHeightRef.current <= 0) return;
      const wrapTop = wrap.getBoundingClientRect().top - card.getBoundingClientRect().top;
      const available = card.clientHeight - wrapTop - foot.getBoundingClientRect().height - 4;
      const per = Math.max(1, Math.floor(available / rowHeightRef.current));
      setRowsPerPage((prev) => (prev === per ? prev : per));
    };

    const frame = requestAnimationFrame(() => requestAnimationFrame(measure));
    const ro = new ResizeObserver(measure);
    ro.observe(card);
    window.addEventListener('resize', measure);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [activeHours.length]);

  const pageCount = rowsPerPage
    ? Math.max(1, Math.ceil(activeHours.length / rowsPerPage))
    : 1;
  const shouldPage = pageCount > 1;

  // Auto-rotate through the table pages every TABLE_ROTATE_MS.
  useEffect(() => {
    if (!shouldPage) return;
    const id = window.setInterval(() => {
      setPage((p) => (p + 1) % pageCount);
      setSwitchAt(Date.now() + TABLE_ROTATE_MS);
    }, TABLE_ROTATE_MS);
    return () => window.clearInterval(id);
  }, [shouldPage, pageCount]);

  // Start from the first page whenever the shift / page count changes.
  useEffect(() => {
    setPage(0);
  }, [pageCount, activeHours.length]);

  // The page of hourly rows currently shown in the table (all rows when short).
  const displayHours = useMemo(() => {
    if (!rowsPerPage) return activeHours;
    const start = Math.min(page * rowsPerPage, Math.max(0, activeHours.length - rowsPerPage));
    return activeHours.slice(start, start + rowsPerPage);
  }, [rowsPerPage, page, activeHours]);

  // "18:00 – 00:00" style label for the visible page.
  const pageLabel = useMemo(() => {
    if (displayHours.length === 0) return '';
    const first = displayHours[0]?.split(' - ')[0]?.trim() ?? '';
    const last = displayHours[displayHours.length - 1]?.split(' - ')[1]?.trim() ?? '';
    return first ? `${first} – ${last}` : '';
  }, [displayHours]);

  const nextInSeconds = Math.max(0, Math.ceil((switchAt - now) / 1000));

  const switchPage = useCallback((p: number) => {
    setPage(p);
    setSwitchAt(Date.now() + TABLE_ROTATE_MS);
  }, []);

  // Auto-rotate between the Live Status and Production table views.
  useEffect(() => {
    const id = window.setInterval(() => {
      setMainView((v) => (v === 'status' ? 'table' : 'status'));
      setViewSwitchAt(Date.now() + transitionMs);
    }, transitionMs);
    return () => window.clearInterval(id);
  }, [transitionMs]);

  // Restart the countdown when the configured transition time changes.
  useEffect(() => {
    setViewSwitchAt(Date.now() + transitionMs);
  }, [transitionMs]);

  const viewNextInSeconds = Math.max(0, Math.ceil((viewSwitchAt - now) / 1000));

  const switchMainView = useCallback((view: 'status' | 'table') => {
    setMainView(view);
    setViewSwitchAt(Date.now() + transitionMs);
  }, [transitionMs]);

  const intervals = useMemo(() => {
    const startStr = activeHours[0]?.split(' - ')[0]?.trim();
    const shiftStartMin = startStr ? timeStrToMinutes(startStr) : 0;
    return activeHours.map((iv) => {
      const [s, e] = iv.split(' - ').map((x) => x.trim());
      return {
        startMin: shiftTimeToMinutes(s, shiftStartMin),
        endMin: shiftTimeToMinutes(e || s, shiftStartMin),
      };
    });
  }, [activeHours]);

  // Each OFS hourly entry is the throughput for the hour starting at its
  // timestamp, so map it to the interval whose start it matches.
  const outputBuckets = useMemo(() => {
    const buckets: number[] = new Array(activeHours.length).fill(0);
    const startStr = activeHours[0]?.split(' - ')[0]?.trim();
    const shiftStartMin = startStr ? timeStrToMinutes(startStr) : 0;
    for (const e of summary) {
      const hhmm = e.hour || e.startText?.slice(11, 16) || '';
      if (!hhmm) continue;
      const min = shiftTimeToMinutes(hhmm, shiftStartMin);
      const idx = intervals.findIndex((iv) => min >= iv.startMin && min < iv.endMin);
      if (idx >= 0) buckets[idx] += e.in || 0;
    }
    return buckets;
  }, [summary, activeHours, intervals]);

  // Downtime logs per shift interval, mirroring the Monitoring page's
  // "Import Downtime" behaviour so the board's table auto-fills the same way.
  const downtimeLogs = useMemo(() => {
    if (!date || activeHours.length === 0) return {};
    return computeDowntimeLogs(
      downtimeEvents.map((e) => ({
        startText: e.start_text,
        endText: epochToConsoleTime(e.end_epoch, e.start_epoch, e.start_text),
        category: e.category,
        reason: e.reason,
        comments: e.comments,
      })),
      activeHours,
      date,
    );
  }, [downtimeEvents, activeHours, date]);

  // Rows for the Monitoring ShiftTable, auto-filled from the live OFS data
  // (rated speed, output and downtime logs). Quality, Safety, Yield and Scrap
  // start empty, and the board is display-only (handlers are no-ops).
  const tableRows = useMemo<Record<number, ShiftRow>>(() => {
    const result: Record<number, ShiftRow> = {};
    for (let i = 0; i < activeHours.length; i++) {
      const rated = ratedSpeeds[i] ?? 0;
      const out = outputBuckets[i] ?? 0;
      result[i] = {
        spd: rated > 0 ? rated.toLocaleString() : '',
        out: out > 0 ? out.toLocaleString() : '',
        log: downtimeLogs[i] ?? '',
        yld: '',
        scr: '',
        q: 0,
        s: 0,
      };
    }
    return result;
  }, [activeHours, ratedSpeeds, outputBuckets, downtimeLogs]);

  const noopRowChange = useCallback(() => {}, []);
  const noopToggle = useCallback(() => {}, []);

  // Rows for the visible page, remapped back to 0-based keys for the table.
  const displayRows = useMemo<Record<number, ShiftRow>>(() => {
    if (!rowsPerPage) return tableRows;
    const start = Math.min(page * rowsPerPage, Math.max(0, activeHours.length - rowsPerPage));
    const result: Record<number, ShiftRow> = {};
    for (let j = 0; j < displayHours.length; j++) {
      const orig = start + j;
      if (tableRows[orig]) result[j] = tableRows[orig]!;
    }
    return result;
  }, [rowsPerPage, page, activeHours.length, tableRows, displayHours]);

  const totals = useMemo(() => {
    let out = 0;
    let oeeSum = 0;
    let oeeCount = 0;
    for (let i = 0; i < activeHours.length; i++) {
      const r = tableRows[i];
      if (!r) continue;
      const rowOut = parseNumber(r.out);
      const rowSpd = parseNumber(r.spd);
      out += rowOut;
      if (rowOut > 0 && rowSpd > 0) {
        oeeSum += (rowOut / rowSpd) * 100;
        oeeCount += 1;
      }
    }
    return {
      out,
      avgOee: oeeCount > 0 ? (oeeSum / oeeCount).toFixed(2) : '0.00',
    };
  }, [tableRows, activeHours]);

  const consoleTime = status?.workcentre?.consoletimeText || status?.timestampText || '-';
  const timezone = status?.workcentre?.consoletimezone || '';

  const runstate = status?.runstate;
  const lineStateClass = classifyLineState(runstate);
  const stateColor = LINE_STATE_COLORS[lineStateClass];
  const stateLabel = runstate?.description || runstate?.name || runstate?.state || 'Idle';

  const currentRate = status?.process?.throughunitpersister?.rate ?? 0;

  const order = job?.$order;
  const product = order?.$product;
  const sku = product?.SKU || order?.clientId || '-';
  const target = job?.quantity ?? 0;
  const ofsProductName = product?.description || order?.name || '';
  const ofsRatedSpeed = job?.metadata?.ratedSpeed ? parseInt(job.metadata.ratedSpeed, 10) : 0;
  const productName = override?.product_name?.trim() || ofsProductName || 'No active job';
  const ratedSpeed = override?.rated_speed ?? ofsRatedSpeed;
  const jobCounts = job?.counts ?? {};
  const unitsIn = status?.process?.unitsin?.value ?? 0;
  const jobThrough = jobCounts.through ?? 0;
  const produced = jobThrough || unitsIn;
  const progress = target > 0 ? Math.min(100, (produced / target) * 100) : 0;
  const remaining = Math.max(0, target - produced);
  const shiftName = status?.shift?.$crew?.name || status?.shift?.$crew?.title || '-';
  const operator = status?.shift?.$user?.name || '-';
  const lineName = status?.workcentre?.name || 'Krones Canning Line';

  const shiftDowntimeEvents = useMemo(
    () =>
      filterByShiftWindow(downtimeEvents, shift, [], date, (e) => e.start_text, undefined, downtimeEventEndText),
    [downtimeEvents, shift, date],
  );

  const estFinish = useMemo(() => {
    if (remaining <= 0) return '--:--:--';
    const speedPerHour = currentRate > 0 ? currentRate * 3600 : ratedSpeed;
    if (speedPerHour <= 0) return '--:--:--';
    const finish = new Date(now + (remaining / speedPerHour) * 3600 * 1000);
    if (timezone) {
      try {
        const parts = new Intl.DateTimeFormat('en-CA', {
          timeZone: timezone,
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false,
        }).formatToParts(finish);
        const h = parts.find((p) => p.type === 'hour')?.value ?? '0';
        const m = parts.find((p) => p.type === 'minute')?.value ?? '00';
        const s = parts.find((p) => p.type === 'second')?.value ?? '00';
        return `${h.padStart(2, '0')}:${m}:${s}`;
      } catch {
        // fall through to local time
      }
    }
    return `${pad(finish.getHours())}:${pad(finish.getMinutes())}:${pad(finish.getSeconds())}`;
  }, [remaining, currentRate, ratedSpeed, now, timezone]);

  return (
    <div className="flex flex-col gap-3 h-full min-h-0">
      {/* ---- View switcher: Live Status ⇄ Production table ---- */}
      <div className="flex items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-1.5" role="tablist" aria-label="Board view">
          <button
            type="button"
            role="tab"
            aria-selected={mainView === 'status'}
            onClick={() => switchMainView('status')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-bold uppercase tracking-wide border transition-colors ${
              mainView === 'status'
                ? 'bg-blue-900 text-white border-blue-900'
                : 'bg-white text-slate-600 border-slate-300 hover:border-blue-400'
            }`}
            title="Show the live line status view"
          >
            <Activity size={13} />
            Live Status
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mainView === 'table'}
            onClick={() => switchMainView('table')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-bold uppercase tracking-wide border transition-colors ${
              mainView === 'table'
                ? 'bg-blue-900 text-white border-blue-900'
                : 'bg-white text-slate-600 border-slate-300 hover:border-blue-400'
            }`}
            title="Show the hourly production table"
          >
            <TrendingUp size={13} />
            Production
          </button>
        </div>
        <span className="text-[11px] font-semibold text-slate-500 tabular-nums">
          next in {viewNextInSeconds}s
        </span>
      </div>

      {/* ---- Animated content area ---- */}
      <div className="relative flex-1 min-h-0 overflow-hidden">
        {error && (
          <div className="absolute top-2 left-2 right-2 z-20 flex items-start gap-3 rounded-xl p-3.5 border border-red-400/50 bg-red-400/20 backdrop-blur-md text-red-800 shadow-lg">
            <AlertTriangle size={18} className="mt-0.5 shrink-0" />
            <div className="text-[13px]">
              <p className="font-bold m-0 mb-1">
                {errorTimedOut ? 'Live data timed out' : "Couldn't load live data"}
              </p>
              <p className="m-0 text-red-700">{error}</p>
            </div>
          </div>
        )}
        {/* ---- Live Status view ---- */}
        <div
          className={`absolute inset-0 transition-opacity duration-700 ${
            mainView === 'status' ? 'opacity-100 z-10' : 'opacity-0 pointer-events-none'
          }`}
        >
          <div className="h-full flex flex-col gap-3 min-h-0">
            <div className="shrink-0 flex items-center justify-between gap-3 px-4 py-2.5 card rounded-lg border border-slate-300 bg-white">
              <div className="flex items-center gap-3">
                <Activity size={20} className="text-brand-900" />
                <h3 className="m-0 text-lg font-bold text-slate-800">{lineName} - Live Status</h3>
              </div>
              <div className="flex items-center gap-3 text-[13px] font-bold text-slate-600 tabular-nums">
                <span className="inline-flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full animate-pulse" style={{ backgroundColor: stateColor }} />
                  {stateLabel}
                </span>
                <span>{consoleTime}</span>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 flex-1 min-h-0">
              <StatusTile
                icon={<Gauge size={22} />}
                label="Line State"
                value={stateLabel}
                accent={lineStateClass}
                badge={
                  <span className="inline-block w-3 h-3 rounded-full animate-pulse shrink-0" style={{ backgroundColor: stateColor }} />
                }
              />
              <StatusTile
                icon={<TrendingUp size={22} />}
                label="Current Rate"
                value={`${Math.round(currentRate * 3600).toLocaleString()} /hr`}
                hint={ratedSpeed > 0 ? `Rated: ${ratedSpeed.toLocaleString()} /hr` : undefined}
                accent="blue"
              />
              <StatusTile
                icon={<Clock size={22} />}
                label="State Time"
                value={formatStateDuration(runstate, now)}
                hint={runstate?.description || runstate?.name || undefined}
                accent={lineStateClass}
                badge={
                  <span className="inline-block w-3 h-3 rounded-full animate-pulse shrink-0" style={{ backgroundColor: stateColor }} />
                }
              />
            </div>

            <div className="shrink-0 flex flex-wrap items-center gap-3 text-[13px] font-semibold">
              {([
                ['running', 'Running'],
                ['slow', 'Running Slow'],
                ['setup', 'Setup'],
                ['downtime', 'Downtime'],
                ['planned', 'Planned Downtime'],
              ] as Array<[LineStateClass, string]>).map(([cls, label]) => (
                <span key={cls} className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-slate-100 text-slate-700">
                  <span className="inline-block w-3 h-3 rounded-full" style={{ backgroundColor: LINE_STATE_COLORS[cls] }} />
                  {label}
                </span>
              ))}
            </div>

            <div className="shrink-0 card rounded-lg px-4 py-3 border border-blue-200 bg-blue-50 text-blue-900">
              <div className="flex items-center justify-between gap-2 mb-2 pb-2 border-b border-current">
                <div className="flex items-center gap-2">
                  <Package size={16} />
                  <h3 className="m-0 text-[14px] font-bold uppercase tracking-wide">Active Job</h3>
                  {override && (
                    <span className="px-2 py-0.5 rounded-full text-[11px] font-bold uppercase tracking-wide bg-blue-900 text-white">
                      Corrected
                    </span>
                  )}
                </div>
                {job && <span className="text-[12px] font-bold text-blue-800">Job #{jobId ?? '—'}</span>}
              </div>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <Field label="Product" value={productName} />
                <Field label="SKU" value={sku} />
                <Field label="Target Quantity" value={target.toLocaleString()} />
                <Field label="Rated Speed" value={ratedSpeed > 0 ? `${ratedSpeed.toLocaleString()} /hr` : '-'} />
              </div>
              <div className="mt-3">
                <div className="flex justify-between items-center mb-1 text-[13px] font-semibold text-blue-900">
                  <span>Production Progress</span>
                  <span className="tabular-nums">
                    {produced.toLocaleString()} / {target.toLocaleString()} ({progress.toFixed(1)}%)
                  </span>
                </div>
                <div className="w-full h-3.5 rounded-full bg-blue-100 overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all duration-700"
                    style={{ width: `${progress}%`, backgroundColor: stateColor }}
                  />
                </div>
                <div className="flex justify-between mt-1.5 text-[12px] text-blue-700 font-medium">
                  <span>Remaining: {remaining.toLocaleString()}</span>
                  {remaining > 0 && (currentRate > 0 || ratedSpeed > 0) && (
                    <span>Est. finish: {estFinish}</span>
                  )}
                </div>
              </div>
            </div>

            <div className="shrink-0 flex flex-wrap items-center justify-between gap-3 text-[13px] font-semibold text-slate-600">
              <div className="flex flex-wrap items-center gap-3">
                <span className="uppercase tracking-wide text-[11px] font-bold opacity-60">Shift</span>
                <span>{SHIFT_LABELS[shift]} · {date || '—'}</span>
                <span className="uppercase tracking-wide text-[11px] font-bold opacity-60">Crew</span>
                <span className="flex items-center gap-1.5">
                  <UserIcon size={14} />
                  {shiftName}
                </span>
                <span className="uppercase tracking-wide text-[11px] font-bold opacity-60">Operator</span>
                <span>{operator}</span>
              </div>
              <span className="tabular-nums text-[12px]">
                {lastUpdated
                  ? `Last updated ${lastUpdated.toLocaleTimeString()} · auto-refreshes every ${liveRefreshMs / 1000}s`
                  : loading
                    ? 'Loading…'
                    : 'No data yet'}
              </span>
            </div>

            <div className="shrink-0 board-timeline">
              <DowntimeTimeline
                events={shiftDowntimeEvents}
                currentShift={shift}
                customHours={[]}
                date={date}
                consoleTime={consoleTime}
                loading={boardLoading}
              />
            </div>
          </div>
        </div>

        {/* ---- Monitoring table view ---- */}
        <div
          className={`absolute inset-0 transition-opacity duration-700 ${
            mainView === 'table' ? 'opacity-100 z-10' : 'opacity-0 pointer-events-none'
          }`}
        >
          <div
            ref={tableCardRef}
            className="card rounded-lg p-3 border border-slate-300 bg-slate-50 h-full flex flex-col"
          >
        <div className="flex items-center justify-between gap-2 mb-2 pb-1.5 border-b border-slate-300 flex-wrap shrink-0">
          <div className="flex items-center gap-2">
            <TrendingUp size={15} className="text-slate-700" />
            <h3 className="m-0 text-[13px] font-bold uppercase tracking-wide text-slate-800">
              Production — {SHIFT_LABELS[shift]} · {pageLabel || date || '—'}
            </h3>
          </div>

          {shouldPage && (
            <div className="flex items-center gap-1.5 shrink-0" role="tablist" aria-label="Table pages">
              {Array.from({ length: pageCount }).map((_, i) => {
                const active = page === i;
                const start = Math.min(i * rowsPerPage!, Math.max(0, activeHours.length - rowsPerPage!));
                const label = activeHours[start]?.split(' - ')[0]?.trim();
                return (
                  <button
                    key={i}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => switchPage(i)}
                    className={`px-2.5 py-0.5 rounded-full text-[11px] font-bold uppercase tracking-wide border transition-colors ${
                      active
                        ? 'bg-blue-900 text-white border-blue-900'
                        : 'bg-white text-slate-600 border-slate-300 hover:border-blue-400'
                    }`}
                    title={`Show page ${i + 1} of ${pageCount}`}
                  >
                    {i + 1} · {label ?? '—'}
                  </button>
                );
              })}
              <span className="text-[11px] font-semibold text-slate-500 tabular-nums ml-1">
                next in {nextInSeconds}s
              </span>
            </div>
          )}

          <div className="flex items-center gap-3 text-[11px] font-semibold text-slate-600 tabular-nums">
            <span>Output: {totals.out.toLocaleString()}</span>
            <span>Avg OEE: {totals.avgOee}%</span>
            {boardLoading && <Loader2 size={12} className="animate-spin text-slate-400" />}
          </div>
        </div>

        <div ref={tableWrapRef} className="min-h-0">
          <ShiftTable
            hours={displayHours}
            rows={displayRows}
            rowCount={displayHours.length}
            onRowChange={noopRowChange}
            onToggle={noopToggle}
          />
        </div>

        <p ref={tableFootRef} className="text-[11px] text-slate-500 font-medium mt-2 mb-0 shrink-0">
          Rated speed, output and downtime logs are pulled live from OFS (Live-page corrections applied).
          OEE = Output ÷ Rated Speed.
        </p>
      </div>

        </div>
      </div>
    </div>
  );
}

function StatusTile({
  icon,
  label,
  value,
  hint,
  accent,
  badge,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
  accent: LineStateClass | 'blue';
  badge?: React.ReactNode;
}) {
  const tones: Record<string, string> = {
    running: 'border-green-200 bg-green-50 text-green-900',
    slow: 'border-lime-300 bg-lime-50 text-lime-900',
    setup: 'border-yellow-200 bg-yellow-50 text-yellow-900',
    downtime: 'border-red-200 bg-red-50 text-red-900',
    planned: 'border-blue-200 bg-blue-50 text-blue-900',
    idle: 'border-slate-200 bg-slate-50 text-slate-900',
    blue: 'border-blue-200 bg-blue-50 text-blue-900',
  };
  return (
    <div className={`card rounded-lg border flex flex-col justify-center p-4 max-h-[90%] ${tones[accent]}`}>
      <div className="flex items-center gap-2 text-[12px] font-bold uppercase tracking-wide opacity-80 mb-2">
        {icon}
        <span>{label}</span>
      </div>
      <div className="flex items-center gap-2.5">
        <span className="text-3xl font-extrabold tabular-nums leading-tight">{value}</span>
        {badge}
      </div>
      {hint && <div className="text-[12px] font-medium opacity-70 mt-1.5">{hint}</div>}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] font-bold uppercase tracking-wide opacity-70 mb-0.5">{label}</div>
      <div className="text-[13px] font-bold tabular-nums">{value}</div>
    </div>
  );
}

function formatStateDuration(runstate: OfsRunState | undefined, now: number): string {
  if (!runstate) return '-';
  if (runstate.start && runstate.start > 0) {
    return formatElapsedMs(Math.max(0, now - runstate.start));
  }
  if (runstate.duration && runstate.duration > 0) {
    return formatElapsedMs(runstate.duration);
  }
  return '-';
}

function formatElapsedMs(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${pad(m)}m ${pad(s)}s`;
  if (m > 0) return `${m}m ${pad(s)}s`;
  return `${s}s`;
}

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}

/**
 * Converts an end_epoch (Unix ms) to an OFS console-time string
 * ("YYYY-MM-DD HH:MM:SS") in the factory's timezone. The factory timezone
 * offset is derived from the event's own start_epoch/start_text pair, so no
 * hardcoded timezone is needed. Returns null if endEpoch is null (ongoing).
 */
function epochToConsoleTime(
  endEpoch: number | null,
  startEpoch: number,
  startText: string | null,
): string | null {
  if (endEpoch === null || !startText) return null;
  const offsetMs = startEpoch - Date.parse(startText.replace(' ', 'T'));
  const shifted = new Date(endEpoch - offsetMs);
  const y = shifted.getFullYear();
  const m = String(shifted.getMonth() + 1).padStart(2, '0');
  const d = String(shifted.getDate()).padStart(2, '0');
  const h = String(shifted.getHours()).padStart(2, '0');
  const min = String(shifted.getMinutes()).padStart(2, '0');
  const s = String(shifted.getSeconds()).padStart(2, '0');
  return `${y}-${m}-${d} ${h}:${min}:${s}`;
}
