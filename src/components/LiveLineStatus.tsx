import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Boxes,
  Clock,
  Gauge,
  Loader2,
  Package,
  RefreshCw,
  TrendingUp,
  User as UserIcon,
} from 'lucide-react';
import { fetchOfsStatus, classifyLineState, LINE_STATE_COLORS, type OfsLiveStatus, type OfsRunState, type LineStateClass } from '@/lib/ofs';
import { fetchHourlySummaryByDate, type HourlySummaryEntry } from '@/lib/counterLogs';
import { fetchDowntimeByDate, type DowntimeEvent } from '@/lib/downtime';
import { filterByShiftWindow, getActiveHours, SHIFT_LABELS, type Shift } from '@/types';
import { DowntimeTimeline } from '@/components/DowntimeTimeline';
import { PageHelp } from '@/components/PageHelp';

const REFRESH_MS = 1000;
const SUMMARY_REFRESH_MS = 30000;

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

function isOvernightShift(shift: Shift, customHours: string[]): boolean {
  const hours = getActiveHours(shift, customHours);
  const startStr = hours[0]?.split(' - ')[0]?.trim();
  return startStr ? parseInt(startStr.split(':')[0], 10) >= 12 : false;
}

interface LiveLineStatusProps {
  currentShift: Shift;
  customHours: string[];
  date: string;
}

export function LiveLineStatus({ currentShift, customHours, date }: LiveLineStatusProps) {
  const [status, setStatus] = useState<OfsLiveStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [summary, setSummary] = useState<HourlySummaryEntry[]>([]);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [downtimeEvents, setDowntimeEvents] = useState<DowntimeEvent[]>([]);
  const [downtimeLoading, setDowntimeLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const data = await fetchOfsStatus(ctrl.signal);
      setStatus(data);
      setError(null);
      setLastUpdated(new Date());
    } catch (err) {
      if (ctrl.signal.aborted) return;
      setError(err instanceof Error ? err.message : 'Failed to load line status');
    } finally {
      if (!ctrl.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    return () => abortRef.current?.abort();
  }, [load]);

  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(load, REFRESH_MS);
    return () => clearInterval(id);
  }, [autoRefresh, load]);

  const loadSummary = useCallback(async (date: string) => {
    setSummaryLoading(true);
    setSummaryError(null);
    try {
      const data = await fetchHourlySummaryByDate(date);
      if (isOvernightShift(currentShift, customHours)) {
        const nextData = await fetchHourlySummaryByDate(nextDateStr(date));
        data.push(...nextData);
      }
      setSummary(data);
    } catch (err) {
      setSummaryError(err instanceof Error ? err.message : 'Failed to load production summary');
      setSummary([]);
    } finally {
      setSummaryLoading(false);
    }
  }, [currentShift, customHours]);

  useEffect(() => {
    if (!date) return;
    loadSummary(date);
    const id = setInterval(() => loadSummary(date), SUMMARY_REFRESH_MS);
    return () => clearInterval(id);
  }, [loadSummary, date]);

  const loadDowntime = useCallback(async (date: string) => {
    setDowntimeLoading(true);
    try {
      const data = await fetchDowntimeByDate(date);
      if (isOvernightShift(currentShift, customHours)) {
        const nextData = await fetchDowntimeByDate(nextDateStr(date));
        data.push(...nextData);
      }
      setDowntimeEvents(data);
    } catch {
      setDowntimeEvents([]);
    } finally {
      setDowntimeLoading(false);
    }
  }, [currentShift, customHours]);

  useEffect(() => {
    if (!date) return;
    loadDowntime(date);
    const id = setInterval(() => loadDowntime(date), SUMMARY_REFRESH_MS);
    return () => clearInterval(id);
  }, [loadDowntime, date]);

  const job = status?.job;
  const order = job?.$order;
  const product = order?.$product;
  const productName = product?.description || order?.name || 'No active job';
  const sku = product?.SKU || order?.clientId || '-';
  const target = job?.quantity ?? 0;
  const ratedSpeed = job?.metadata?.ratedSpeed ? parseInt(job.metadata.ratedSpeed, 10) : 0;
  const jobCounts = job?.counts ?? {};

  const unitsIn = status?.process?.unitsin?.value ?? 0;
  const unitsOut = status?.process?.unitsout?.value ?? 0;
  const jobThrough = jobCounts.through ?? 0;
  const produced = jobThrough || unitsIn;
  const progress = target > 0 ? Math.min(100, (produced / target) * 100) : 0;

  const shift = status?.shift;
  const shiftName = shift?.$crew?.name || shift?.$crew?.title || '-';
  const operator = shift?.$user?.name || '-';
  const operatorTitle = shift?.$user?.title || '';
  const shiftCounts = shift?.counts ?? {};
  const shiftThrough = shiftCounts.through ?? 0;
  const shiftOut = shiftCounts.out ?? 0;

  const runstate = status?.runstate;
  const lineStateClass = classifyLineState(runstate);
  const stateColor = LINE_STATE_COLORS[lineStateClass];

  const currentRate = status?.process?.throughunitpersister?.rate ?? 0;

  const workcentre = status?.workcentre;
  const lineName = workcentre?.name || 'Krones Canning Line';
  const timezone = workcentre?.consoletimezone || '';
  const consoleTime = workcentre?.consoletimeText || status?.timestampText || '-';

  const remaining = Math.max(0, target - produced);

  const shiftSummary = useMemo(
    () => filterByShiftWindow(summary, currentShift, customHours, date, (e) => e.startText, (e) => e.hour),
    [summary, currentShift, customHours, date],
  );

  const totalIn = useMemo(() => shiftSummary.reduce((s, e) => s + e.in, 0), [shiftSummary]);
  const totalOut = useMemo(() => shiftSummary.reduce((s, e) => s + e.out, 0), [shiftSummary]);

  const shiftDowntimeEvents = useMemo(
    () => filterByShiftWindow(downtimeEvents, currentShift, customHours, date, (e) => e.start_text),
    [downtimeEvents, currentShift, customHours, date],
  );

  return (
    <div>
      <PageHelp
        title="Live Status"
        intro="See real-time line status from OFS, refreshing every second. Monitor the current state, production rate, job progress, and hourly throughput without touching OFS."
        sections={[
          {
            title: "Top section - live line status",
            items: [
              "Line State shows whether the line is running, in setup, down, or planned, colour-coded to match.",
              "Current Rate shows the current throughput in cans per hour, with the rated speed shown underneath when available.",
              "State Time shows how long the line has been in its current state.",
              "Auto-refresh is on by default and updates every second. Toggle it off to pause, or use the Refresh button to load once.",
              "If the data can't load, check that the OFS credentials are configured as Supabase secrets.",
            ],
          },
          {
            title: "Active job card",
            items: [
              "Shows the current product, SKU, target quantity, and rated speed for the running job.",
              "The progress bar shows how far through the job you are (produced vs target), the remaining quantity, and an estimated finish time based on the current or rated speed.",
            ],
          },
          {
            title: "Shift timeline",
            items: [
              "The bar shows downtime events across the shift, colour-coded: red for unplanned, blue for planned, yellow for setup.",
              "A dark vertical line marks the current time within the shift.",
              "The green portion shows how far through the shift you are.",
            ],
          },
          {
            title: "Shift counts and process counters",
            items: [
              "Shift Counts shows the current crew and operator, plus the shift's throughput and output totals.",
              "Live Process Counters show units in (filler) and units out (date coder) in real time, along with the active job's produced and throughput totals.",
            ],
          },
          {
            title: "Hourly production summary",
            items: [
              "The table at the bottom shows per-hour In (throughput) and Out (output) for the selected shift and date, with a total row.",
              "Use the date picker at the top of the page to look at a different day.",
              "The summary loads once a date is chosen and refreshes automatically. Use its Refresh button to reload it at any time.",
            ],
          },
        ]}
      />

      <div className="flex items-center justify-between mb-4 flex-wrap gap-3 no-print">
        <div className="flex items-center gap-2">
          <Activity className="text-brand-900" size={22} />
          <h2 className="text-lg font-bold text-brand-900 m-0">{lineName} - Live Status</h2>
        </div>
        <div className="flex items-center gap-2.5">
          <label className="flex items-center gap-1.5 text-[12px] font-semibold text-slate-600 cursor-pointer">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="accent-brand-900"
            />
            Auto-refresh
          </label>
          <button
            type="button"
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-md text-[12px] font-bold text-white bg-brand-900 hover:bg-brand-800 transition-colors"
            onClick={load}
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-3 rounded-lg p-4 mb-4 border border-red-200 bg-red-50 text-red-800">
          <AlertTriangle size={20} className="mt-0.5 shrink-0" />
          <div className="text-[13px]">
            <p className="font-bold m-0 mb-1">Couldn't load live data</p>
            <p className="m-0 text-red-700">{error}</p>
            <p className="m-0 mt-2 text-[12px] text-red-600">
              If this is the first run, the OFS credentials may not be set as Supabase secrets yet.
            </p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
        <StatusCard
          icon={<Gauge size={18} />}
          label="Line State"
          value={runstate?.description || runstate?.name || '-'}
          accent={lineStateClass}
          badge={<span className="inline-block w-2.5 h-2.5 rounded-full animate-pulse" style={{ backgroundColor: stateColor }} />}
        />
        <StatusCard
          icon={<TrendingUp size={18} />}
          label="Current Rate"
          value={`${Math.round(currentRate * 3600).toLocaleString()} /hr`}
          hint={ratedSpeed > 0 ? `Rated: ${ratedSpeed.toLocaleString()} /hr` : undefined}
          accent="blue"
        />
        <StatusCard
          icon={<Clock size={18} />}
          label="State Time"
          value={formatStateDuration(runstate, lastUpdated)}
          hint={runstate?.description || runstate?.name || undefined}
          accent={lineStateClass}
          badge={<span className="inline-block w-2.5 h-2.5 rounded-full animate-pulse" style={{ backgroundColor: stateColor }} />}
        />
      </div>

      <div className="card rounded-lg p-4 mb-4 border border-blue-200 bg-blue-50 text-blue-900">
        <div className="flex items-center gap-2 mb-3 pb-2 border-b border-current">
          <Package size={18} />
          <h3 className="m-0 text-sm font-bold uppercase tracking-wide">Active Job</h3>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <Field label="Product" value={productName} />
          <Field label="SKU" value={sku} />
          <Field label="Target Quantity" value={target.toLocaleString()} />
          <Field label="Rated Speed" value={ratedSpeed > 0 ? `${ratedSpeed.toLocaleString()} /hr` : '-'} />
        </div>

        <div className="mt-4">
          <div className="flex justify-between items-center mb-1.5 text-[12px] font-semibold text-blue-900">
            <span>Production Progress</span>
            <span>
              {produced.toLocaleString()} / {target.toLocaleString()} ({progress.toFixed(1)}%)
            </span>
          </div>
          <div className="w-full h-3 rounded-full bg-blue-100 overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-700"
              style={{ width: `${progress}%`, backgroundColor: stateColor }}
            />
          </div>
          <div className="flex justify-between mt-1.5 text-[11px] text-blue-700 font-medium">
            <span>Remaining: {remaining.toLocaleString()}</span>
            {remaining > 0 && (currentRate > 0 || ratedSpeed > 0) && (
              <span>Est. finish: {formatEstFinish(remaining, currentRate > 0 ? currentRate * 3600 : ratedSpeed, timezone)}</span>
            )}
          </div>
        </div>
      </div>

      <DowntimeTimeline
        events={shiftDowntimeEvents}
        currentShift={currentShift}
        customHours={customHours}
        date={date}
        consoleTime={consoleTime}
        loading={downtimeLoading}
      />

      <div className="flex flex-wrap items-center gap-3 mb-4 text-[11px] font-semibold">
        {([
          ['running', 'Running'],
          ['setup', 'Setup'],
          ['downtime', 'Downtime'],
          ['planned', 'Planned Downtime'],
        ] as Array<[LineStateClass, string]>).map(([cls, label]) => (
          <span key={cls} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-slate-100 text-slate-700">
            <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ backgroundColor: LINE_STATE_COLORS[cls] }} />
            {label}
          </span>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        <div className="card rounded-lg p-4 border border-green-200 bg-green-50 text-green-900">
          <div className="flex items-center gap-2 mb-3 pb-2 border-b border-current">
            <Boxes size={18} />
            <h3 className="m-0 text-sm font-bold uppercase tracking-wide">Shift Counts</h3>
          </div>
          <div className="flex items-center gap-2 mb-3">
            <span className="px-2.5 py-1 rounded-md bg-green-200 text-green-900 text-[11px] font-bold uppercase tracking-wide">
              {shiftName}
            </span>
            {operatorTitle && (
              <span className="text-[11px] text-green-700 font-medium">{operatorTitle}</span>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Throughput" value={shiftThrough.toLocaleString()} />
            <Field label="Output" value={shiftOut.toLocaleString()} />
          </div>
          <div className="flex items-center gap-2 mt-3 pt-2.5 border-t border-green-200 text-[12px] font-medium text-green-800">
            <UserIcon size={14} />
            <span>Operator: {operator}</span>
          </div>
        </div>

        <div className="card rounded-lg p-4 border border-teal-200 bg-teal-50 text-teal-900">
          <div className="flex items-center gap-2 mb-3 pb-2 border-b border-current">
            <Activity size={18} />
            <h3 className="m-0 text-sm font-bold uppercase tracking-wide">Live Process Counters</h3>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Units In (filler)" value={unitsIn.toLocaleString()} />
            <Field label="Units Out (date coder)" value={unitsOut.toLocaleString()} />
          </div>
          <div className="flex justify-between items-center mt-3 pt-2.5 border-t border-teal-200 text-[12px] font-medium text-teal-800">
            <span>Job produced (out): {(jobCounts.out ?? 0).toLocaleString()}</span>
            <span>Job throughput: {(jobCounts.through ?? 0).toLocaleString()}</span>
          </div>
        </div>
      </div>

      <div className="card rounded-lg p-4 mb-4 border border-slate-300 bg-slate-50">
        <div className="flex items-center justify-between gap-2 mb-3 pb-2 border-b border-slate-300 flex-wrap">
          <div className="flex items-center gap-2">
            <Boxes size={18} className="text-slate-700" />
            <h3 className="m-0 text-sm font-bold uppercase tracking-wide text-slate-800">
              Production Counter Summary - {SHIFT_LABELS[currentShift]}
            </h3>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-bold text-white bg-brand-700 hover:bg-brand-800 transition-colors"
              onClick={() => date && loadSummary(date)}
              disabled={summaryLoading || !date}
            >
              {summaryLoading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
              Refresh
            </button>
          </div>
        </div>

        <p className="text-[12px] text-slate-600 m-0 mb-4 leading-relaxed">
          Hourly production counts pulled live from OFS. Each row shows the In (throughput)
          and Out (output) for that hour — no background capture needed.
        </p>

        {summaryError && (
          <div className="flex items-start gap-2 rounded-md p-3 mb-3 border border-red-200 bg-red-50 text-red-800 text-[12px]">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            <span>{summaryError}</span>
          </div>
        )}

        {summaryLoading && summary.length === 0 ? (
          <div className="flex items-center justify-center py-8 text-slate-400">
            <Loader2 size={20} className="animate-spin" />
            <span className="ml-2 text-[13px] font-medium">Loading production summary…</span>
          </div>
        ) : !date ? (
          <div className="text-center text-[13px] text-slate-500 font-medium py-6">
            Pick a date above to load production counts for that day.
          </div>
        ) : shiftSummary.length === 0 ? (
          <div className="text-center text-[13px] text-slate-500 font-medium py-6">
            No production data for {SHIFT_LABELS[currentShift]} on {date}.
          </div>
        ) : (
            <div className="card rounded-lg border border-slate-200 bg-white overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-200 bg-slate-50">
                <h3 className="m-0 text-sm font-bold uppercase tracking-wide text-slate-700">
                  {SHIFT_LABELS[currentShift]} · Hourly Production Counts
                </h3>
              </div>
              <div className="overflow-x-auto">
                <table className="text-[13px] w-max min-w-full mx-auto">
                  <thead>
                    <tr className="text-center text-[11px] font-bold uppercase tracking-wide text-slate-500 border-b border-slate-200">
                      <th className="px-4 py-2.5 whitespace-nowrap">Hour</th>
                      <th className="px-4 py-2.5 whitespace-nowrap">In (Throughput)</th>
                      <th className="px-4 py-2.5 whitespace-nowrap">Out (Output)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shiftSummary.map((entry, i) => (
                      <tr key={i} className="border-b border-slate-100 hover:bg-slate-50 transition-colors">
                        <td className="px-4 py-3 text-center font-medium text-slate-700 whitespace-nowrap">{formatHourRange(entry.hour)}</td>
                        <td className="px-4 py-3 text-center font-semibold text-slate-700 whitespace-nowrap">{entry.in.toLocaleString()}</td>
                        <td className="px-4 py-3 text-center font-semibold text-slate-700 whitespace-nowrap">{entry.out.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-slate-300 bg-slate-50">
                      <td className="px-4 py-3 text-center font-bold text-slate-800 whitespace-nowrap">Total</td>
                      <td className="px-4 py-3 text-center font-bold text-slate-800 whitespace-nowrap">{totalIn.toLocaleString()}</td>
                      <td className="px-4 py-3 text-center font-bold text-slate-800 whitespace-nowrap">{totalOut.toLocaleString()}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
        )}
      </div>

      <div className="text-center text-[11px] text-slate-500 font-medium">
        {lastUpdated ? (
          <span>
            Last updated {lastUpdated.toLocaleTimeString()}
            {autoRefresh ? ` · auto-refreshes every ${REFRESH_MS / 1000}s` : ''}
          </span>
        ) : (
          <span>{loading ? 'Loading…' : 'No data yet'}</span>
        )}
      </div>
    </div>
  );
}

function StatusCard({
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
  accent: LineStateClass | 'blue' | 'slate';
  badge?: React.ReactNode;
}) {
  const tones: Record<string, string> = {
    running: 'border-green-200 bg-green-50 text-green-900',
    setup: 'border-yellow-200 bg-yellow-50 text-yellow-900',
    downtime: 'border-red-200 bg-red-50 text-red-900',
    planned: 'border-blue-200 bg-blue-50 text-blue-900',
    idle: 'border-slate-200 bg-slate-50 text-slate-900',
    blue: 'border-blue-200 bg-blue-50 text-blue-900',
    slate: 'border-slate-200 bg-slate-50 text-slate-900',
  };
  return (
    <div className={`card rounded-lg p-3.5 border ${tones[accent]}`}>
      <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide opacity-80 mb-1">
        {icon}
        <span>{label}</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xl font-bold">{value}</span>
        {badge}
      </div>
      {hint && <div className="text-[11px] font-medium opacity-70 mt-0.5">{hint}</div>}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] font-bold uppercase tracking-wide opacity-70 mb-0.5">{label}</div>
      <div className="text-[14px] font-bold">{value}</div>
    </div>
  );
}

function formatEstFinish(remaining: number, speedPerHour: number, timezone?: string): string {
  if (speedPerHour <= 0 || remaining <= 0) return '--:--:--';
  const totalSec = (remaining / speedPerHour) * 3600;
  const finish = new Date(Date.now() + totalSec * 1000);
  if (timezone) {
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false,
      }).formatToParts(finish);
      const h = parts.find((p) => p.type === 'hour')?.value ?? '0';
      const m = parts.find((p) => p.type === 'minute')?.value ?? '00';
      const s = parts.find((p) => p.type === 'second')?.value ?? '00';
      return `${h.padStart(2, '0')}:${m}:${s}`;
    } catch {
      // fall through to local
    }
  }
  return `${pad(finish.getHours())}:${pad(finish.getMinutes())}:${pad(finish.getSeconds())}`;
}

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}

function formatHourRange(hour: string): string {
  const match = hour.match(/^(\d{1,2}):(\d{2})/);
  if (!match) return hour;
  const h = parseInt(match[1], 10);
  const m = match[2];
  const nextH = (h + 1) % 24;
  return `${String(h).padStart(2, '0')}:${m} - ${String(nextH).padStart(2, '0')}:${m}`;
}

function formatStateDuration(runstate: OfsRunState | undefined, lastUpdated: Date | null): string {
  if (!runstate) return '-';
  if (runstate.start && runstate.start > 0) {
    const now = lastUpdated ? lastUpdated.getTime() : Date.now();
    const elapsedMs = Math.max(0, now - runstate.start);
    return formatElapsedMs(elapsedMs);
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
