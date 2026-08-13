import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Clock,
  Gauge,
  Package,
  TrendingUp,
  User as UserIcon,
} from 'lucide-react';
import { loadLiveIntervals } from '@/lib/liveConfig';
import type { BoardShiftLayout } from '@/lib/boardConfig';
import {
  classifyLineState,
  fetchOfsStatus,
  LINE_STATE_COLORS,
  type LineStateClass,
  type OfsLiveStatus,
  type OfsRunState,
} from '@/lib/ofs';
import { loadJobOverride, type JobOverride } from '@/lib/jobOverrides';
import { fetchDowntimeForShift, downtimeEventEndText, type DowntimeEvent } from '@/lib/downtime';
import {
  filterByShiftWindow,
  getActiveHours,
  SHIFT_LABELS,
  SHIFT_LIST,
  type Shift,
} from '@/types';
import { DowntimeTimeline } from '@/components/DowntimeTimeline';
import { ShiftTableCard } from '@/components/ShiftTableCard';

const DEFAULT_LIVE_MS = 3000;
const DEFAULT_SUMMARY_MS = 30000;
const VIEW_ROTATE_MS = 20000;

interface BoardViewProps {
  transitionMs?: number;
  shiftLayout?: BoardShiftLayout;
}

type BoardMainView = 'status' | 'table' | 'prevTable' | 'prev2Table';

// Short tab labels for the factory's 3x 8-hour shifts, used when the Board is
// set to the "3 shifts" layout.
const SHIFT8_LABELS: Record<string, string> = {
  '1st': '1st · 06:00–14:00',
  '2nd': '2nd · 14:00–22:00',
  '3rd': '3rd · 22:00–06:00',
};

function dateToStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// The previous shift in the factory's rotation (e.g. Night before Morning,
// 1st before 2nd), used for the "previous shift" production table. Custom has
// no defined predecessor.
function previousShift(shift: Shift): Shift | null {
  switch (shift) {
    case 'Morning':
      return 'Night';
    case 'Night':
      return 'Morning';
    case '1st':
      return '3rd';
    case '2nd':
      return '1st';
    case '3rd':
      return '2nd';
    default:
      return null;
  }
}

// Calendar date of the previous shift's start, derived from the current
// shift's start time: shifts starting before noon are preceded by an overnight
// shift that began on the previous calendar day.
function previousShiftDate(shift: Shift, date: string): string {
  const hours = getActiveHours(shift, []);
  const startStr = hours[0]?.split(' - ')[0]?.trim();
  const startHour = startStr ? parseInt(startStr.split(':')[0] ?? '0', 10) : 0;
  if (startHour < 12) {
    const d = new Date(`${date}T00:00:00`);
    d.setDate(d.getDate() - 1);
    return dateToStr(d);
  }
  return date;
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

// In the 3x8 layout the OFS shift type isn't usable (it reports a generic
// code), so the current 8-hour shift is derived from the console clock:
// 06:00-14:00 = 1st, 14:00-22:00 = 2nd, 22:00-06:00 = 3rd. A 3rd shift running
// before 06:00 started at 22:00 on the previous calendar day.
function detectThreeShiftContext(status: OfsLiveStatus | null): { shift: Shift; date: string } {
  const consoleTime = status?.workcentre?.consoletimeText || status?.timestampText || '';
  const match = consoleTime.match(/(\d{1,2}):(\d{2})/);
  const hour = match ? parseInt(match[1], 10) : 6;
  let shift: Shift;
  if (hour >= 6 && hour < 14) shift = '1st';
  else if (hour >= 14 && hour < 22) shift = '2nd';
  else shift = '3rd';

  const baseDate =
    consoleTime.match(/^(\d{4}-\d{2}-\d{2})/)?.[1] ||
    status?.shift?.startText?.slice(0, 10) ||
    dateToStr(new Date());
  if (shift === '3rd' && hour < 22) {
    const d = new Date(`${baseDate}T00:00:00`);
    d.setDate(d.getDate() - 1);
    return { shift, date: dateToStr(d) };
  }
  return { shift, date: baseDate };
}

export function BoardView({ transitionMs = VIEW_ROTATE_MS, shiftLayout = '12h' }: BoardViewProps) {
  const [status, setStatus] = useState<OfsLiveStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorTimedOut, setErrorTimedOut] = useState(false);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [liveRefreshMs, setLiveRefreshMs] = useState(DEFAULT_LIVE_MS);
  const [summaryRefreshMs, setSummaryRefreshMs] = useState(DEFAULT_SUMMARY_MS);
  const [downtimeEvents, setDowntimeEvents] = useState<DowntimeEvent[]>([]);
  const [boardLoading, setBoardLoading] = useState(false);
  const [override, setOverride] = useState<JobOverride | null>(null);
  const [now, setNow] = useState(Date.now());
  const [mainView, setMainView] = useState<BoardMainView>('status');
  const [viewSwitchAt, setViewSwitchAt] = useState(Date.now() + transitionMs);

  // 3x8 layout shows the three 8-hour shift tables instead of the current
  // 12-hour shift table (plus its previous shift).
  const isThreeShiftLayout = shiftLayout === '3x8';

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

  // Downtime for the Live Status timeline reloads whenever the detected shift
  // window changes (e.g. at a shift boundary) or on the summary interval.
  useEffect(() => {
    if (!date) return;
    let cancelled = false;

    const loadTimeline = async () => {
      setBoardLoading(true);
      try {
        const events = await fetchDowntimeForShift(shift, [], date);
        if (cancelled) return;
        setDowntimeEvents(events);
      } catch {
        // keep the last known events on the board if a refresh fails
      } finally {
        if (!cancelled) setBoardLoading(false);
      }
    };

    loadTimeline();
    const timer = window.setInterval(loadTimeline, summaryRefreshMs);
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

  // Previous shift in the factory rotation, so the board can also show the
  // table from the shift that ran before the current one.
  const prevShift = useMemo(() => previousShift(shift), [shift]);
  const prevDate = useMemo(
    () => (prevShift ? previousShiftDate(shift, date) : ''),
    [prevShift, shift, date],
  );

  // The shift-table views differ by layout: 12h uses the detected 12-hour
  // shift (plus its predecessor); 3x8 uses the current 8-hour shift read from
  // the console clock plus its two predecessors, mirroring the same
  // current/previous behaviour but covering the full 24-hour rotation.
  const { tableShift, tableDate, tablePrevShift, tablePrevDate, tablePrev2Shift, tablePrev2Date } =
    useMemo(() => {
      if (isThreeShiftLayout) {
        const ctx = detectThreeShiftContext(status);
        const prev = previousShift(ctx.shift);
        const prevDate = prev ? previousShiftDate(ctx.shift, ctx.date) : '';
        const prev2 = prev ? previousShift(prev) : null;
        const prev2Date = prev && prevDate ? previousShiftDate(prev, prevDate) : '';
        return {
          tableShift: ctx.shift,
          tableDate: ctx.date,
          tablePrevShift: prev,
          tablePrevDate: prevDate,
          tablePrev2Shift: prev2,
          tablePrev2Date: prev2Date,
        };
      }
      return {
        tableShift: shift,
        tableDate: date,
        tablePrevShift: prevShift,
        tablePrevDate: prevDate,
        tablePrev2Shift: null,
        tablePrev2Date: '',
      };
    }, [isThreeShiftLayout, status, shift, date, prevShift, prevDate]);

  const mainViews = useMemo<BoardMainView[]>(() => {
    const views: BoardMainView[] = ['status', 'table'];
    if (tablePrevShift) views.push('prevTable');
    if (isThreeShiftLayout && tablePrev2Shift && tablePrev2Date) views.push('prev2Table');
    return views;
  }, [isThreeShiftLayout, tablePrevShift, tablePrev2Shift, tablePrev2Date]);

  // When the configured layout changes, fall back to a view that exists in the
  // new rotation instead of leaving the board showing nothing.
  useEffect(() => {
    setMainView((v) => (mainViews.includes(v) ? v : 'status'));
  }, [mainViews]);

  // Auto-rotate through the Live Status and shift-table views.
  useEffect(() => {
    const id = window.setInterval(() => {
      setMainView((v) => {
        const idx = mainViews.indexOf(v);
        return mainViews[(idx + 1) % mainViews.length] ?? 'status';
      });
      setViewSwitchAt(Date.now() + transitionMs);
    }, transitionMs);
    return () => window.clearInterval(id);
  }, [transitionMs, mainViews]);

  // Restart the countdown when the configured transition time changes.
  useEffect(() => {
    setViewSwitchAt(Date.now() + transitionMs);
  }, [transitionMs]);

  const viewNextInSeconds = Math.max(0, Math.ceil((viewSwitchAt - now) / 1000));

  const switchMainView = useCallback((view: BoardMainView) => {
    setMainView(view);
    setViewSwitchAt(Date.now() + transitionMs);
  }, [transitionMs]);

  const consoleTime = status?.workcentre?.consoletimeText || status?.timestampText || '-';
  const timezone = status?.workcentre?.consoletimezone || '';

  const runstate = status?.runstate;
  const lineStateClass = classifyLineState(runstate);
  const stateColor = LINE_STATE_COLORS[lineStateClass];
  const stateLabel = runstate?.description || runstate?.name || runstate?.state || 'Idle';

  // TEMP-PREVIEW: `?downtimePopup=1` forces the popup open regardless of line
  // state so it can be inspected without waiting for real downtime.
  const forcePopupPreview = typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('downtimePopup') === '1';
  const showDowntimePopup = lineStateClass === 'downtime' && mainView === 'status' || forcePopupPreview;
  const showDowntimeFlashBorder = lineStateClass === 'downtime' && mainView !== 'status' && !forcePopupPreview;
  const downtimeElapsed = runstate?.start && runstate.start > 0
    ? formatStateDuration(runstate, now)
    : (runstate?.duration && runstate.duration > 0 ? formatElapsedMs(runstate.duration) : '-');

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

  // The active downtime event backing the red popup: an unresolved event whose
  // start matches the current run-state start, falling back to the most recent
  // unresolved one.
  const activeDowntimeEvent = useMemo(() => {
    if (lineStateClass !== 'downtime' && !forcePopupPreview) return undefined;
    const runStateStart = runstate?.start ?? 0;
    const windowEvents = forcePopupPreview
      ? shiftDowntimeEvents
      : shiftDowntimeEvents.filter((e) => !e.resolved);
    if (windowEvents.length === 0) return undefined;
    if (runStateStart > 0) {
      const matched = windowEvents.find(
        (e) => Math.abs((e.start_epoch ?? 0) - runStateStart) < 5 * 60_000,
      );
      if (matched) return matched;
    }
    return windowEvents[windowEvents.length - 1];
  }, [lineStateClass, forcePopupPreview, runstate?.start, shiftDowntimeEvents]);

  const activeIsSlow = activeDowntimeEvent?.downtime_type === 'RUNNING_SLOW';
  const popupStyle = activeIsSlow
    ? {
        borderColor: '#ca8a04',
        background: 'linear-gradient(180deg, #fefce8, #fef9c3)',
        overlay: 'rgba(133, 77, 14, 0.35)',
        dot: '#ca8a04',
        titleColor: '#854d0e',
        tile: 'bg-yellow-100 border-yellow-200',
        textColor: 'text-yellow-900',
        tileSolid: 'bg-yellow-200',
        divider: 'border-yellow-200',
        footerColor: 'text-yellow-800',
      }
    : {
        borderColor: '#dc2626',
        background: 'linear-gradient(180deg, #fef2f2, #fee2e2)',
        overlay: 'rgba(127, 29, 29, 0.45)',
        dot: '#dc2626',
        titleColor: '#991b1b',
        tile: 'bg-red-100 border-red-200',
        textColor: 'text-red-900',
        tileSolid: 'bg-red-200',
        divider: 'border-red-200',
        footerColor: 'text-red-700',
      };

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
      {/* ---- View switcher: Live Status ⇄ Production ⇄ Previous shift ---- */}
      <div className="flex items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-1.5 flex-wrap" role="tablist" aria-label="Board view">
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
            title={`Show the ${isThreeShiftLayout ? `${SHIFT_LABELS[tableShift]} ` : ''}production table`}
          >
            <TrendingUp size={13} />
            {isThreeShiftLayout ? SHIFT8_LABELS[tableShift] ?? 'Production' : 'Production'}
          </button>
          {tablePrevShift && (
            <button
              type="button"
              role="tab"
              aria-selected={mainView === 'prevTable'}
              onClick={() => switchMainView('prevTable')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-bold uppercase tracking-wide border transition-colors ${
                mainView === 'prevTable'
                  ? 'bg-blue-900 text-white border-blue-900'
                  : 'bg-white text-slate-600 border-slate-300 hover:border-blue-400'
              }`}
              title={`Show the previous shift (${SHIFT_LABELS[tablePrevShift]}) production table`}
            >
              <TrendingUp size={13} />
              Prev · {isThreeShiftLayout ? (SHIFT8_LABELS[tablePrevShift] ?? SHIFT_LABELS[tablePrevShift]) : SHIFT_LABELS[tablePrevShift]}
            </button>
          )}
          {isThreeShiftLayout && tablePrev2Shift && tablePrev2Date && (
            <button
              type="button"
              role="tab"
              aria-selected={mainView === 'prev2Table'}
              onClick={() => switchMainView('prev2Table')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-bold uppercase tracking-wide border transition-colors ${
                mainView === 'prev2Table'
                  ? 'bg-blue-900 text-white border-blue-900'
                  : 'bg-white text-slate-600 border-slate-300 hover:border-blue-400'
              }`}
              title={`Show the shift before the previous one (${SHIFT_LABELS[tablePrev2Shift]}) production table`}
            >
              <TrendingUp size={13} />
              Prev-2 · {SHIFT8_LABELS[tablePrev2Shift] ?? SHIFT_LABELS[tablePrev2Shift]}
            </button>
          )}
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

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 flex-[0.4] min-h-0">
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

            <div className="shrink-0 card rounded-lg px-4 py-3 border border-blue-200 bg-blue-50 text-blue-900 flex-1 min-h-0 flex flex-col" style={{ zoom: 0.97 }}>
              <div className="flex items-center justify-between gap-2 mb-3 pb-3 border-b border-current shrink-0">
                <div className="flex items-center gap-2">
                  <Package size={20} />
                  <h3 className="m-0 text-xl font-bold uppercase tracking-wide">Active Job</h3>
                  {override && (
                    <span className="px-2.5 py-1 rounded-full text-base font-bold uppercase tracking-wide bg-blue-900 text-white">
                      Corrected
                    </span>
                  )}
                </div>
                {job && <span className="text-lg font-bold text-blue-800">Job #{jobId ?? '—'}</span>}
              </div>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 shrink-0">
                <Field label="Product" value={productName} />
                <Field label="SKU" value={sku} />
                <Field label="Target Quantity" value={target.toLocaleString()} />
                <Field label="Rated Speed" value={ratedSpeed > 0 ? `${ratedSpeed.toLocaleString()} /hr` : '-'} />
              </div>
              <div className="mt-4 flex-1 min-h-0 flex flex-col justify-center">
                <div className="flex justify-between items-center mb-2 text-lg font-semibold text-blue-900">
                  <span>Production Progress</span>
                  <span className="tabular-nums">
                    {produced.toLocaleString()} / {target.toLocaleString()} ({progress.toFixed(1)}%)
                  </span>
                </div>
                <div className="w-full h-5 rounded-full bg-blue-100 overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all duration-700"
                    style={{ width: `${progress}%`, backgroundColor: stateColor }}
                  />
                </div>
                <div className="flex justify-between mt-2.5 text-lg text-blue-700 font-medium">
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

        {/* ---- Current shift table view ---- */}
        <div
          className={`absolute inset-0 transition-opacity duration-700 ${
            mainView === 'table' ? 'opacity-100 z-10' : 'opacity-0 pointer-events-none'
          }`}
        >
          <div className={`h-full ${showDowntimeFlashBorder ? 'downtime-flash' : ''}`}>
            <ShiftTableCard shift={tableShift} date={tableDate} summaryRefreshMs={summaryRefreshMs} consoleTime={consoleTime} />
          </div>
        </div>

        {/* ---- Previous shift table view ---- */}
        {tablePrevShift && tablePrevDate && (
          <div
            className={`absolute inset-0 transition-opacity duration-700 ${
              mainView === 'prevTable' ? 'opacity-100 z-10' : 'opacity-0 pointer-events-none'
            }`}
          >
            <div className={`h-full ${showDowntimeFlashBorder ? 'downtime-flash' : ''}`}>
              <ShiftTableCard shift={tablePrevShift} date={tablePrevDate} summaryRefreshMs={summaryRefreshMs} previous consoleTime={consoleTime} />
            </div>
          </div>
        )}

        {/* ---- Shift before the previous one (3x8 layout) ---- */}
        {isThreeShiftLayout && tablePrev2Shift && tablePrev2Date && (
          <div
            className={`absolute inset-0 transition-opacity duration-700 ${
              mainView === 'prev2Table' ? 'opacity-100 z-10' : 'opacity-0 pointer-events-none'
            }`}
          >
            <div className={`h-full ${showDowntimeFlashBorder ? 'downtime-flash' : ''}`}>
              <ShiftTableCard shift={tablePrev2Shift} date={tablePrev2Date} summaryRefreshMs={summaryRefreshMs} previous consoleTime={consoleTime} />
            </div>
          </div>
        )}
        </div>

      {/* ---- Red Downtime popup ---- */}
      {showDowntimePopup && (
        <div
          className="modal-overlay"
          style={{ zIndex: 200, background: popupStyle.overlay, backdropFilter: 'blur(6px)', pointerEvents: 'none' }}
        >
          <div
            className="modal-card"
            style={{ maxWidth: 560, border: `3px solid ${popupStyle.borderColor}`, background: popupStyle.background }}
            role="dialog"
            aria-modal="true"
            aria-label={activeIsSlow ? 'Line running slow alert' : 'Line downtime alert'}
          >
            <div className={`flex items-center gap-2 mb-3 pb-3 border-b-2 ${popupStyle.divider}`}>
              <span className="inline-block w-4 h-4 rounded-full animate-pulse" style={{ backgroundColor: popupStyle.dot }} />
              <h2 className="m-0 text-2xl font-bold uppercase tracking-wide" style={{ color: popupStyle.titleColor }}>
                {activeIsSlow ? 'Running Slow' : 'Downtime'}
              </h2>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className={`rounded-lg p-3 border ${popupStyle.tile}`}>
                <div className={`text-sm font-bold uppercase tracking-wide opacity-70 mb-1 ${popupStyle.textColor}`}>Line</div>
                <div className={`text-xl font-bold ${popupStyle.textColor}`}>{lineName}</div>
              </div>
              <div className={`rounded-lg p-3 border ${popupStyle.tile}`}>
                <div className={`text-sm font-bold uppercase tracking-wide opacity-70 mb-1 ${popupStyle.textColor}`}>Type</div>
                <div className={`text-xl font-bold ${popupStyle.textColor}`}>
                  {activeDowntimeEvent?.downtime_type === 'RUNNING_SLOW' ? 'Running Slow' : (activeDowntimeEvent?.downtime_type || stateLabel)}
                </div>
              </div>
              <div className={`rounded-lg p-3 border ${popupStyle.tile}`}>
                <div className={`text-sm font-bold uppercase tracking-wide opacity-70 mb-1 ${popupStyle.textColor}`}>Elapsed</div>
                <div className={`text-xl font-bold tabular-nums ${popupStyle.textColor}`}>{downtimeElapsed}</div>
              </div>
              <div className={`rounded-lg p-3 border ${popupStyle.tile}`}>
                <div className={`text-sm font-bold uppercase tracking-wide opacity-70 mb-1 ${popupStyle.textColor}`}>Console</div>
                <div className={`text-xl font-bold tabular-nums ${popupStyle.textColor}`}>{formatConsoleTime(consoleTime)}</div>
              </div>
            </div>
            <div className={`mt-3 rounded-lg p-3 border ${popupStyle.tile}`}>
              <div className={`text-sm font-bold uppercase tracking-wide opacity-70 mb-1 ${popupStyle.textColor}`}>Reason</div>
              <div className={`text-lg font-bold ${popupStyle.textColor}`}>
                {activeDowntimeEvent?.reason?.trim() || 'Not classified yet'}
              </div>
              {activeDowntimeEvent?.category?.trim() ? (
                <div className={`mt-1 inline-block rounded-full px-2.5 py-0.5 text-xs font-bold uppercase tracking-wide ${popupStyle.tileSolid}`} style={{ color: popupStyle.titleColor }}>
                  {activeDowntimeEvent.category}
                </div>
              ) : null}
            </div>
            <div className={`flex flex-col gap-1 mt-4 pt-3 border-t text-sm font-semibold ${popupStyle.divider} ${popupStyle.footerColor}`}>
              <div className="flex items-center gap-2">
                <AlertTriangle size={16} className="shrink-0" />
                {activeIsSlow
                  ? 'The line is running below rated speed.'
                  : 'The line is down.'}
              </div>
              {!activeIsSlow && <div className="pl-6">Please provide reason or next job.</div>}
            </div>
          </div>
        </div>
      )}
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
      <div className="text-base font-bold uppercase tracking-wide opacity-70 mb-1">{label}</div>
      <div className="text-2xl font-bold tabular-nums leading-tight break-words">{value}</div>
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

// Format a raw OFS console time like "2026-08-11 17:34:42.477" down to just the
// clock time "17:34:42" so it fits the popup tiles. Falls back to the raw value
// (or "-") when it doesn't look like a timestamp.
function formatConsoleTime(value: string | undefined | null): string {
  if (!value) return '-';
  const match = value.match(/(\d{1,2}):(\d{2}):(\d{2})/);
  if (!match) return value;
  return `${match[1]}:${match[2]}:${match[3]}`;
}
