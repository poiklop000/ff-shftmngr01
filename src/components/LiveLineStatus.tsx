import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Boxes,
  Check,
  Clock,
  Gauge,
  Loader2,
  Package,
  Pencil,
  RefreshCw,
  RotateCcw,
  TrendingUp,
  User as UserIcon,
  X,
} from 'lucide-react';
import { loadLiveIntervals } from '@/lib/liveConfig';
import { fetchOfsStatus, classifyLineState, LINE_STATE_COLORS, type OfsLiveStatus, type OfsRunState, type LineStateClass } from '@/lib/ofs';
import { loadJobOverride, saveJobOverride, deleteJobOverride, type JobOverride } from '@/lib/jobOverrides';
import { fetchHourlySummaryByDate, type HourlySummaryEntry } from '@/lib/counterLogs';
import { fetchHourlyRatedSpeeds } from '@/lib/jobSnapshots';
import { fetchDowntimeByDate, downtimeEventEndText, type DowntimeEvent } from '@/lib/downtime';
import { filterByShiftWindow, getActiveHours, SHIFT_LABELS, type Shift } from '@/types';
import { DowntimeTimeline } from '@/components/DowntimeTimeline';
import { PageHelp } from '@/components/PageHelp';

const DEFAULT_LIVE_MS = 3000;
const DEFAULT_SUMMARY_MS = 30000;

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
  const [hourlyRatedSpeeds, setHourlyRatedSpeeds] = useState<Record<number, number>>({});
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [downtimeEvents, setDowntimeEvents] = useState<DowntimeEvent[]>([]);
  const [downtimeLoading, setDowntimeLoading] = useState(false);
  const [liveRefreshMs, setLiveRefreshMs] = useState(DEFAULT_LIVE_MS);
  const [summaryRefreshMs, setSummaryRefreshMs] = useState(DEFAULT_SUMMARY_MS);
  const [override, setOverride] = useState<JobOverride | null>(null);
  const [editing, setEditing] = useState(false);
  const [draftProduct, setDraftProduct] = useState('');
  const [draftSpeed, setDraftSpeed] = useState('');
  const [overrideSaving, setOverrideSaving] = useState(false);
  const [overrideError, setOverrideError] = useState<string | null>(null);
  const [overrideMsg, setOverrideMsg] = useState<string | null>(null);
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
    if (!autoRefresh) return;
    const id = setInterval(load, liveRefreshMs);
    return () => clearInterval(id);
  }, [autoRefresh, load, liveRefreshMs]);

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
      const rated = await fetchHourlyRatedSpeeds(date, currentShift, customHours);
      setHourlyRatedSpeeds(rated);
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
    const id = setInterval(() => loadSummary(date), summaryRefreshMs);
    return () => clearInterval(id);
  }, [loadSummary, date, summaryRefreshMs]);

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
    const id = setInterval(() => loadDowntime(date), summaryRefreshMs);
    return () => clearInterval(id);
  }, [loadDowntime, date, summaryRefreshMs]);

  const job = status?.job;
  const order = job?.$order;
  const product = order?.$product;
  const jobId = job?.id ?? null;
  const lineStateClass = classifyLineState(status?.runstate);
  const isIdle = lineStateClass === 'idle';
  const sku = isIdle ? '-' : (product?.SKU || order?.clientId || '-');
  const target = isIdle ? 0 : (job?.quantity ?? 0);
  const ofsProductName = product?.description || order?.name || '';
  const ofsRatedSpeed = job?.metadata?.ratedSpeed ? parseInt(job.metadata.ratedSpeed, 10) : 0;
  const productName = isIdle ? 'No active job' : (override?.product_name?.trim() || ofsProductName || 'No active job');
  const ratedSpeed = override?.rated_speed ?? ofsRatedSpeed;
  const jobCounts = job?.counts ?? {};

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

  // Each OFS hourly entry is labelled with the hour it starts at, so the 18:00
  // bucket is the output produced between 18:00 and 19:00. Show it as a range.
  // Map each shift-hour label (e.g. "18:00") to its per-job rated speed so the
  // production table shows the correct speed for every hour instead of the
  // single current-job speed.
  const hourRatedSpeedMap = useMemo(() => {
    const hours = getActiveHours(currentShift, customHours);
    const map = new Map<string, number>();
    for (const [idx, speed] of Object.entries(hourlyRatedSpeeds)) {
      const hourLabel = hours[parseInt(idx)]?.split(' - ')[0]?.trim();
      if (hourLabel && speed > 0) map.set(hourLabel, speed);
    }
    return map;
  }, [hourlyRatedSpeeds, currentShift, customHours]);

  const productionRows = useMemo(
    () => shiftSummary.map((e) => ({
      hour: hourRangeLabel(e.hour),
      output: e.in,
      ratedSpeed: hourRatedSpeedMap.get(e.hour?.trim() ?? '') ?? 0,
    })),
    [shiftSummary, hourRatedSpeedMap],
  );

  const shiftDowntimeEvents = useMemo(
    () => filterByShiftWindow(downtimeEvents, currentShift, customHours, date, (e) => e.start_text, undefined, downtimeEventEndText),
    [downtimeEvents, currentShift, customHours, date],
  );

  const startEdit = () => {
    setDraftProduct(override?.product_name?.trim() || ofsProductName);
    setDraftSpeed(ratedSpeed > 0 ? String(ratedSpeed) : '');
    setEditing(true);
    setOverrideError(null);
    setOverrideMsg(null);
  };

  const handleSaveOverride = async () => {
    if (jobId == null) return;
    const speed = parseInt(draftSpeed, 10);
    if (!draftProduct.trim() || !Number.isFinite(speed) || speed <= 0) {
      setOverrideError('Enter a product name and a valid rated speed (cans per hour).');
      return;
    }
    setOverrideSaving(true);
    setOverrideError(null);
    setOverrideMsg(null);
    try {
      await saveJobOverride(jobId, draftProduct.trim(), speed);
      setOverride(await loadJobOverride(jobId));
      setEditing(false);
      setOverrideMsg('Saved — this job now uses the corrected values in the report and snapshots.');
      window.setTimeout(() => setOverrideMsg(null), 5000);
    } catch (err) {
      setOverrideError(err instanceof Error ? err.message : 'Could not save the override.');
    } finally {
      setOverrideSaving(false);
    }
  };

  const handleResetOverride = async () => {
    if (jobId == null) return;
    setOverrideSaving(true);
    setOverrideError(null);
    setOverrideMsg(null);
    try {
      await deleteJobOverride(jobId);
      setOverride(null);
      setEditing(false);
      setOverrideMsg('Reset — back to the raw OFS values.');
      window.setTimeout(() => setOverrideMsg(null), 5000);
    } catch (err) {
      setOverrideError(err instanceof Error ? err.message : 'Could not reset the override.');
    } finally {
      setOverrideSaving(false);
    }
  };

  return (
    <div>
      <PageHelp
        title="Live Status"
        intro="See real-time line status from OFS, refreshing automatically. Monitor the current state, production rate, job progress, and hourly throughput without touching OFS."
        sections={[
          {
            title: "Top section - live line status",
            items: [
              "Line State shows whether the line is running, in setup, down, or planned, colour-coded to match.",
              "Current Rate shows the current throughput in cans per hour, with the rated speed shown underneath when available.",
              "State Time shows how long the line has been in its current state.",
              "Auto-refresh is on by default and updates on a set interval. Toggle it off to pause, or use the Refresh button to load once. The refresh intervals are configured on the Admin page.",
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
        <div className="flex items-center justify-between gap-2 mb-3 pb-2 border-b border-current">
          <div className="flex items-center gap-2">
            <Package size={18} />
            <h3 className="m-0 text-sm font-bold uppercase tracking-wide">Active Job</h3>
            {override && !editing && (
              <span className="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide bg-blue-900 text-white">
                Corrected
              </span>
            )}
          </div>
          {job && !editing && (
            <button
              type="button"
              onClick={startEdit}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-bold text-white bg-brand-900 hover:bg-brand-800 transition-colors"
            >
              <Pencil size={13} />
              Edit
            </button>
          )}
        </div>

        {editing ? (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <div>
                <div className="text-[11px] font-bold uppercase tracking-wide opacity-70 mb-0.5">Product name</div>
                <input
                  type="text"
                  className="form-control"
                  value={draftProduct}
                  onChange={(e) => setDraftProduct(e.target.value)}
                  disabled={overrideSaving}
                />
              </div>
              <Field label="SKU" value={sku} />
              <Field label="Target Quantity" value={target.toLocaleString()} />
              <div>
                <div className="text-[11px] font-bold uppercase tracking-wide opacity-70 mb-0.5">Rated speed (cans/hr)</div>
                <input
                  type="number"
                  min="1"
                  className="form-control"
                  value={draftSpeed}
                  onChange={(e) => setDraftSpeed(e.target.value)}
                  disabled={overrideSaving}
                />
              </div>
            </div>

            <div className="flex items-center gap-2 flex-wrap mt-3">
              <button
                type="button"
                onClick={handleSaveOverride}
                disabled={overrideSaving}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-bold text-white bg-brand-900 hover:bg-brand-800 transition-colors"
              >
                {overrideSaving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                {overrideSaving ? 'Saving…' : 'Save'}
              </button>
              <button
                type="button"
                onClick={() => setEditing(false)}
                disabled={overrideSaving}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-bold text-blue-900 bg-blue-100 hover:bg-blue-200 transition-colors"
              >
                <X size={13} />
                Cancel
              </button>
              {override && (
                <button
                  type="button"
                  onClick={handleResetOverride}
                  disabled={overrideSaving}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-bold text-blue-900 bg-blue-100 hover:bg-blue-200 transition-colors"
                >
                  <RotateCcw size={13} />
                  Reset to OFS
                </button>
              )}
            </div>

            <div className="text-[11px] font-medium opacity-70 mt-2">
              Saved to the database for this job — the corrected values follow through to the monitoring
              report and the job snapshots. Anything you leave unchanged is saved as-is.
            </div>

            {overrideError && (
              <div className="flex items-start gap-2 rounded-md p-3 mt-2 border border-red-200 bg-red-50 text-red-800 text-[12px]">
                <AlertTriangle size={15} className="mt-0.5 shrink-0" />
                <span>{overrideError}</span>
              </div>
            )}
            {overrideMsg && (
              <div className="flex items-start gap-2 rounded-md p-3 mt-2 border border-green-200 bg-green-50 text-green-900 text-[12px]">
                <Check size={15} className="mt-0.5 shrink-0" />
                <span>{overrideMsg}</span>
              </div>
            )}
          </>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <Field label="Product" value={productName} />
            <Field label="SKU" value={sku} />
            <Field label="Target Quantity" value={target.toLocaleString()} />
            <Field label="Rated Speed" value={ratedSpeed > 0 ? `${ratedSpeed.toLocaleString()} /hr` : '-'} />
          </div>
        )}

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
        lineState={lineStateClass}
      />

      <div className="flex flex-wrap items-center gap-3 mb-4 text-[11px] font-semibold">
        {([
          ['running', 'Running'],
          ['slow', 'Running Slow'],
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
              Today's Production - {SHIFT_LABELS[currentShift]}
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
          Hourly output pulled live from OFS, compared against the active job's rated speed.
          OEE = Output ÷ Rated Speed.
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
        ) : productionRows.length === 0 ? (
          <div className="text-center text-[13px] text-slate-500 font-medium py-6">
            No production data for {SHIFT_LABELS[currentShift]} on {date}.
          </div>
        ) : (
            <div className="card rounded-lg border border-slate-200 bg-white overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-200 bg-slate-50">
                <h3 className="m-0 text-sm font-bold uppercase tracking-wide text-slate-700">
                  {SHIFT_LABELS[currentShift]} · Today's Production
                </h3>
              </div>
              <div className="overflow-x-auto">
                <table className="text-[13px] w-max min-w-full mx-auto">
                  <thead>
                    <tr className="text-center text-[11px] font-bold uppercase tracking-wide text-slate-500 border-b border-slate-200">
                      <th className="px-4 py-2.5 whitespace-nowrap">Time</th>
                      <th className="px-4 py-2.5 whitespace-nowrap">Rated Speed</th>
                      <th className="px-4 py-2.5 whitespace-nowrap">Output</th>
                      <th className="px-4 py-2.5 whitespace-nowrap">OEE</th>
                    </tr>
                  </thead>
                  <tbody>
                    {productionRows.map((row, i) => (
                      <tr key={i} className="border-b border-slate-100 hover:bg-slate-50 transition-colors">
                        <td className="px-4 py-3 text-center font-medium text-slate-700 whitespace-nowrap">{row.hour}</td>
                        <td className="px-4 py-3 text-center font-semibold text-slate-700 whitespace-nowrap">{row.ratedSpeed > 0 ? row.ratedSpeed.toLocaleString() : '-'}</td>
                        <td className="px-4 py-3 text-center font-semibold text-slate-700 whitespace-nowrap">{row.output.toLocaleString()}</td>
                        <td className="px-4 py-3 text-center whitespace-nowrap">
                          {(() => {
                            const oee = row.ratedSpeed > 0 ? (row.output / row.ratedSpeed) * 100 : 0;
                            const oeeClass = row.ratedSpeed > 0
                              ? oee >= 70 ? 'oee-pass' : 'oee-fail'
                              : 'oee-neutral';
                            return (
                              <span className={`oee-badge ${oeeClass}`}>
                                {row.ratedSpeed > 0 ? `${oee.toFixed(2)}%` : '0.00%'}
                              </span>
                            );
                          })()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
        )}
      </div>

      <div className="text-center text-[11px] text-slate-500 font-medium">
        {lastUpdated ? (
          <span>
            Last updated {lastUpdated.toLocaleTimeString()}
            {autoRefresh ? ` · auto-refreshes every ${liveRefreshMs / 1000}s` : ''}
          </span>
        ) : (
          <span>{loading ? 'Loading…' : 'No data yet'}</span>
        )}
      </div>
    </div>
  );
}

function hourRangeLabel(hour: string): string {
  const [hStr, mStr] = hour.split(':');
  const h = Number(hStr);
  const m = Number(mStr);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return hour;
  const total = ((h * 60 + m + 60) % 1440 + 1440) % 1440;
  const eh = Math.floor(total / 60);
  const em = total % 60;
  return `${hour} - ${String(eh).padStart(2, '0')}:${String(em).padStart(2, '0')}`;
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
    slow: 'border-lime-300 bg-lime-50 text-lime-900',
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
