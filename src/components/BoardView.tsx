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
}

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

export function BoardView({ transitionMs = VIEW_ROTATE_MS }: BoardViewProps) {
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
  const [mainView, setMainView] = useState<'status' | 'table' | 'prevTable'>('status');
  const [viewSwitchAt, setViewSwitchAt] = useState(Date.now() + transitionMs);

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

  const mainViews = useMemo<Array<'status' | 'table' | 'prevTable'>>(
    () => (prevShift ? ['status', 'table', 'prevTable'] : ['status', 'table']),
    [prevShift],
  );

  // Auto-rotate through the Live Status, current-shift and previous-shift views.
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

  const switchMainView = useCallback((view: 'status' | 'table' | 'prevTable') => {
    setMainView(view);
    setViewSwitchAt(Date.now() + transitionMs);
  }, [transitionMs]);

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
            title="Show the hourly production table"
          >
            <TrendingUp size={13} />
            Production
          </button>
          {prevShift && (
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
              title={`Show the previous shift (${SHIFT_LABELS[prevShift]}) production table`}
            >
              <TrendingUp size={13} />
              Prev · {SHIFT_LABELS[prevShift]}
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

        {/* ---- Current shift table view ---- */}
        <div
          className={`absolute inset-0 transition-opacity duration-700 ${
            mainView === 'table' ? 'opacity-100 z-10' : 'opacity-0 pointer-events-none'
          }`}
        >
          <ShiftTableCard shift={shift} date={date} summaryRefreshMs={summaryRefreshMs} />
        </div>

        {/* ---- Previous shift table view ---- */}
        {prevShift && (
          <div
            className={`absolute inset-0 transition-opacity duration-700 ${
              mainView === 'prevTable' ? 'opacity-100 z-10' : 'opacity-0 pointer-events-none'
            }`}
          >
            <ShiftTableCard shift={prevShift} date={prevDate} summaryRefreshMs={summaryRefreshMs} previous />
          </div>
        )}
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
