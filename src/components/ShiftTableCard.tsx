import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, TrendingUp } from 'lucide-react';
import {
  computeDowntimeLogs,
  consoleTimeToShiftMinutes,
  getActiveHours,
  parseNumber,
  SHIFT_LABELS,
  type Shift,
  type ShiftRow,
} from '@/types';
import { fetchHourlySummaryByDate, type HourlySummaryEntry } from '@/lib/counterLogs';
import { fetchDowntimeForShift, type DowntimeEvent } from '@/lib/downtime';
import { fetchHourlyRatedSpeeds } from '@/lib/jobSnapshots';
import { loadMonitoringRecord } from '@/lib/monitoring';
import { ShiftTable } from '@/components/ShiftTable';

const DEFAULT_SUMMARY_MS = 30000;

interface ShiftTableCardProps {
  shift: Shift;
  date: string;
  summaryRefreshMs?: number;
  previous?: boolean;
  consoleTime?: string;
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

function isOvernightShift(shift: Shift): boolean {
  const hours = getActiveHours(shift, []);
  const startStr = hours[0]?.split(' - ')[0]?.trim();
  return startStr ? parseInt(startStr.split(':')[0], 10) >= 12 : false;
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

export function ShiftTableCard({
  shift,
  date,
  summaryRefreshMs = DEFAULT_SUMMARY_MS,
  previous = false,
  consoleTime,
}: ShiftTableCardProps) {
  const [summary, setSummary] = useState<HourlySummaryEntry[]>([]);
  const [ratedSpeeds, setRatedSpeeds] = useState<Record<number, number>>({});
  const [downtimeEvents, setDowntimeEvents] = useState<DowntimeEvent[]>([]);
  const [savedRows, setSavedRows] = useState<Record<number, ShiftRow> | null>(null);
  const [boardLoading, setBoardLoading] = useState(false);
  const [rowHeight, setRowHeight] = useState<number | null>(null);
  const tableCardRef = useRef<HTMLDivElement>(null);
  const tableWrapRef = useRef<HTMLDivElement>(null);
  const tableFootRef = useRef<HTMLParagraphElement>(null);

  const activeHours = useMemo(() => getActiveHours(shift, []), [shift]);

  // Board data (hourly counts, rated speeds, downtime) reloads whenever the
  // shift window changes (e.g. at a shift boundary) or on the summary interval.
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
        // Operator-entered rows (Quality/Safety/Yield/Scrap) come from the
        // Monitoring page's saved record for this shift, if one exists.
        const record = await loadMonitoringRecord(date, shift);
        if (cancelled) return;
        setSummary(day);
        setRatedSpeeds(rated);
        setDowntimeEvents(events);
        setSavedRows(record?.board_data?.rows ?? null);
      } catch {
        // keep the last known data if a refresh fails
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

  // Stretch-to-fill: measure the card's usable table area and distribute it
  // evenly across every hourly row so the full shift fits with no paging and
  // no scroll. Re-measures whenever the card or table wrap resizes.
  useEffect(() => {
    const card = tableCardRef.current;
    const wrap = tableWrapRef.current;
    const foot = tableFootRef.current;
    if (!card || !wrap || !foot) return;

    const measure = () => {
      const totalRows = activeHours.length;
      if (totalRows <= 0) return;
      const wrapTop = wrap.getBoundingClientRect().top - card.getBoundingClientRect().top;
      const header = wrap.querySelector('thead')?.getBoundingClientRect().height ?? 0;
      const available = card.clientHeight - wrapTop - header - foot.getBoundingClientRect().height - 4;
      const per = Math.max(1, Math.floor((available * 0.97) / totalRows));
      setRowHeight((prev) => (prev === per ? prev : per));
    };

    const frame = requestAnimationFrame(() => requestAnimationFrame(measure));
    const ro = new ResizeObserver(measure);
    ro.observe(card);
    ro.observe(wrap);
    window.addEventListener('resize', measure);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [activeHours.length]);

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
  // timestamp, so map it to the interval whose start it matches. Entries are
  // matched by their full console timestamp (date + time) and filtered to the
  // shift window so readings from adjacent days can't collide with the same
  // HH:MM on the shift day (e.g. an overnight shift's 00:00 must not also pick
  // up the previous day's 00:00 reading).
  const outputBuckets = useMemo(() => {
    const buckets: number[] = new Array(activeHours.length).fill(0);
    const startStr = activeHours[0]?.split(' - ')[0]?.trim();
    const shiftStartMin = startStr ? timeStrToMinutes(startStr) : 0;
    const lastHourStr = activeHours[activeHours.length - 1]?.split(' - ')[1]?.trim();
    const shiftEndMin = lastHourStr ? shiftTimeToMinutes(lastHourStr, shiftStartMin) : 0;
    for (const e of summary) {
      const min = e.startText
        ? consoleTimeToShiftMinutes(e.startText, date)
        : shiftTimeToMinutes(e.hour || '', shiftStartMin);
      if (min < shiftStartMin || min >= shiftEndMin) continue;
      const idx = intervals.findIndex((iv) => min >= iv.startMin && min < iv.endMin);
      if (idx >= 0) buckets[idx] += e.in || 0;
    }
    return buckets;
  }, [summary, activeHours, intervals, date]);

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
      consoleTime,
    );
  }, [downtimeEvents, activeHours, date, consoleTime]);

  // Rows for the Monitoring ShiftTable, auto-filled from the live OFS data
  // (rated speed, output and downtime logs). Quality, Safety, Yield and Scrap
  // are filled from the operator's saved Monitoring record when available, and
  // the board is display-only (handlers are no-ops).
  const tableRows = useMemo<Record<number, ShiftRow>>(() => {
    const result: Record<number, ShiftRow> = {};
    for (let i = 0; i < activeHours.length; i++) {
      const rated = ratedSpeeds[i] ?? 0;
      const out = outputBuckets[i] ?? 0;
      const saved = savedRows?.[i];
      result[i] = {
        spd: rated > 0 ? rated.toLocaleString() : '',
        out: out > 0 ? out.toLocaleString() : '',
        log: downtimeLogs[i] ?? '',
        yld: saved?.yld?.trim() ? saved.yld : '',
        scr: saved?.scr?.trim() ? saved.scr : '',
        q: saved?.q ?? 0,
        s: saved?.s ?? 0,
      };
    }
    return result;
  }, [activeHours, ratedSpeeds, outputBuckets, downtimeLogs, savedRows]);

  const hasSavedData = useMemo(
    () =>
      savedRows != null &&
      Object.values(savedRows).some((r) => r.yld?.trim() || r.scr?.trim() || (r.q ?? 0) !== 0 || (r.s ?? 0) !== 0),
    [savedRows],
  );

  const noopRowChange = useCallback(() => {}, []);
  const noopToggle = useCallback(() => {}, []);

  // All rows at once — no paging, rows are stretched to fill the card.
  const displayRows = tableRows;

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

  return (
    <div
      ref={tableCardRef}
      className="card rounded-lg p-3 border border-slate-300 bg-slate-50 h-full flex flex-col"
    >
      <div className="flex items-center justify-between gap-2 mb-2 pb-1.5 border-b border-slate-300 flex-wrap shrink-0">
        <div className="flex items-center gap-2">
          <TrendingUp size={15} className="text-slate-700" />
          <h3 className="m-0 text-[13px] font-bold uppercase tracking-wide text-slate-800">
            Production — {SHIFT_LABELS[shift]} · {date || '—'}
          </h3>
          {previous && (
            <span className="px-2 py-0.5 rounded-full text-[11px] font-bold uppercase tracking-wide bg-amber-500 text-white">
              Previous Shift
            </span>
          )}
          {hasSavedData && (
            <span className="px-2 py-0.5 rounded-full text-[11px] font-bold uppercase tracking-wide bg-emerald-500 text-white">
              Saved Data
            </span>
          )}
        </div>

        <div className="flex items-center gap-3 text-[11px] font-semibold text-slate-600 tabular-nums">
          <span>Output: {totals.out.toLocaleString()}</span>
          <span>Avg OEE: {totals.avgOee}%</span>
          {boardLoading && <Loader2 size={12} className="animate-spin text-slate-400" />}
        </div>
      </div>

      <div ref={tableWrapRef} className="min-h-0 flex-1 overflow-hidden">
        <ShiftTable
          hours={activeHours}
          rows={displayRows}
          rowCount={activeHours.length}
          onRowChange={noopRowChange}
          onToggle={noopToggle}
          hideQaFields
          rowHeight={rowHeight}
        />
      </div>

      <p ref={tableFootRef} className="text-[11px] text-slate-500 font-medium mt-2 mb-0 shrink-0">
        Rated speed, output and downtime logs are pulled live from OFS (Live-page corrections applied).
        OEE = Output ÷ Rated Speed.
      </p>
    </div>
  );
}
