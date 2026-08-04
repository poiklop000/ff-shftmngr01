import { useMemo } from 'react';
import { Activity, Loader2 } from 'lucide-react';
import { consoleTimeToShiftMinutes, getActiveHours, type Shift } from '@/types';
import type { DowntimeEvent } from '@/lib/downtime';

const TYPE_COLORS: Record<string, string> = {
  UNPLANNED: '#dc2626',
  PLANNED: '#2563eb',
  SETUP: '#eab308',
  RUNNING_SLOW: '#9acd32',
};

const RUNNING_COLOR = '#16a34a';

function getTypeColor(type: string | null): string {
  if (!type) return '#94a3b8';
  return TYPE_COLORS[type.toUpperCase()] ?? '#94a3b8';
}

function timeStrToMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function formatHour(min: number): string {
  const m = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function formatDurationShort(minutes: number): string {
  if (minutes < 1) return '<1m';
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

function computeNowPct(
  consoleTime: string,
  shiftDate: string,
  shiftStartMin: number,
  shiftEndMin: number,
  totalMin: number,
): number | null {
  if (!consoleTime || consoleTime === '-') return null;
  const timeMatch = consoleTime.match(/(\d{1,2}):(\d{2})/);
  if (!timeMatch) return null;
  const h = parseInt(timeMatch[1], 10);
  const m = parseInt(timeMatch[2], 10);
  const minOfDay = h * 60 + m;

  const isOvernight = shiftEndMin > 1440;
  let shiftMin = minOfDay;

  const dateMatch = consoleTime.match(/^(\d{4}-\d{2}-\d{2})/);
  if (dateMatch) {
    const consoleDate = dateMatch[1]!;
    if (consoleDate === shiftDate) {
      // Time on the shift's own start date that falls before shiftStart means
      // the shift has not begun yet (overnight shifts start in the evening),
      // so there is no "now" inside the window. Keep shiftMin = minOfDay and
      // let the bounds check below return null.
    } else if (isOvernight) {
      const [sy, sm, sd] = shiftDate.split('-').map(Number);
      const [ey, em, ed] = consoleDate.split('-').map(Number);
      const dayDiff = Math.round(
        (Date.UTC(ey, em - 1, ed) - Date.UTC(sy, sm - 1, sd)) / 86_400_000,
      );
      if (dayDiff === 1) {
        shiftMin = minOfDay + 1440;
      } else {
        return null;
      }
    } else {
      return null;
    }
  } else if (isOvernight && minOfDay < shiftStartMin) {
    shiftMin = minOfDay + 1440;
  }

  if (shiftMin < shiftStartMin || shiftMin > shiftEndMin) return null;
  return ((shiftMin - shiftStartMin) / totalMin) * 100;
}

type ShiftTimeStatus = 'not-started' | 'in-progress' | 'ended' | 'unknown';

// Classifies where "now" (the live console time) sits relative to the selected
// shift window. A shift whose date is in the future — or whose start time on
// its own date hasn't arrived yet (e.g. Night 18:00 viewed at 05:08) — is
// "not-started": no events can have occurred in it, so nothing should render.
function getShiftTimeStatus(
  consoleTime: string,
  shiftDate: string,
  shiftStartMin: number,
  shiftEndMin: number,
): ShiftTimeStatus {
  if (!consoleTime || consoleTime === '-') return 'unknown';
  if (!/^\d{4}-\d{2}-\d{2}/.test(consoleTime) || !/\d{1,2}:\d{2}/.test(consoleTime)) return 'unknown';
  const nowShiftMin = consoleTimeToShiftMinutes(consoleTime, shiftDate);
  if (nowShiftMin < shiftStartMin) return 'not-started';
  if (nowShiftMin > shiftEndMin) return 'ended';
  return 'in-progress';
}

interface TimelineBlock {
  leftPct: number;
  widthPct: number;
  color: string;
  label: string;
  durationLabel: string;
}

interface HourMark {
  pct: number;
  label: string;
  showLabel: boolean;
}

interface DowntimeTimelineProps {
  events: DowntimeEvent[];
  currentShift: Shift;
  customHours: string[];
  date: string;
  consoleTime: string;
  loading?: boolean;
}

export function DowntimeTimeline({
  events,
  currentShift,
  customHours,
  date,
  consoleTime,
  loading,
}: DowntimeTimelineProps) {
  const { blocks, hourMarks, nowPct, runWidthPct, totalDowntimeMin, eventCount, status } = useMemo(() => {
    const hours = getActiveHours(currentShift, customHours);
    if (hours.length === 0 || !date) {
      return {
        blocks: [] as TimelineBlock[],
        hourMarks: [] as HourMark[],
        nowPct: null,
        runWidthPct: 100,
        totalDowntimeMin: 0,
        eventCount: 0,
        status: 'unknown' as ShiftTimeStatus,
      };
    }

    const startStr = hours[0]!.split(' - ')[0]!.trim();
    const endStr = hours[hours.length - 1]!.split(' - ')[1]!.trim();
    const shiftStartMin = timeStrToMinutes(startStr);
    const endMinRaw = timeStrToMinutes(endStr);
    const shiftEndMin = endMinRaw <= shiftStartMin ? endMinRaw + 1440 : endMinRaw;
    const totalMin = shiftEndMin - shiftStartMin;

    const status = getShiftTimeStatus(consoleTime, date, shiftStartMin, shiftEndMin);

    const nowPct = computeNowPct(consoleTime, date, shiftStartMin, shiftEndMin, totalMin);
    let nowShiftMin: number | null = null;
    if (nowPct !== null) {
      nowShiftMin = shiftStartMin + (nowPct / 100) * totalMin;
    }

    const blocks: TimelineBlock[] = [];
    let totalDowntimeMin = 0;
    // A shift that hasn't started yet has no events of its own; events fetched
    // for its date are leftovers from the previous shift's tail, so show none.
    if (status !== 'not-started') {
      for (const evt of events) {
        if (!evt.start_text) continue;
        const startMin = consoleTimeToShiftMinutes(evt.start_text, date);
        const endMin = evt.resolved
          ? startMin + (evt.duration_ms ?? 0) / 60000
          : nowShiftMin ?? shiftEndMin;

        if (endMin <= shiftStartMin || startMin >= shiftEndMin) continue;

        const clampedStart = Math.max(startMin, shiftStartMin);
        const clampedEnd = Math.min(endMin, shiftEndMin);
        const durMin = clampedEnd - clampedStart;
        if (durMin <= 0) continue;

        const leftPct = ((clampedStart - shiftStartMin) / totalMin) * 100;
        const widthPct = (durMin / totalMin) * 100;
        const reason = evt.reason ?? evt.category ?? 'Downtime';

        blocks.push({
          leftPct,
          widthPct: Math.max(widthPct, 0.3),
          color: getTypeColor(evt.downtime_type),
          label: reason,
          durationLabel: formatDurationShort(durMin),
        });
        totalDowntimeMin += durMin;
      }
    }

    const hourMarks: HourMark[] = [];
    const labelInterval = totalMin > 600 ? 2 : 1;
    for (let m = shiftStartMin, i = 0; m <= shiftEndMin; m += 60, i++) {
      const pct = ((m - shiftStartMin) / totalMin) * 100;
      hourMarks.push({
        pct,
        label: formatHour(m),
        showLabel: i % labelInterval === 0,
      });
    }

    const runWidthPct = status === 'not-started' ? 0 : nowPct !== null ? nowPct : 100;

    return { blocks, hourMarks, nowPct, runWidthPct, totalDowntimeMin, eventCount: blocks.length, status };
  }, [events, currentShift, customHours, date, consoleTime]);

  return (
    <div className="card rounded-lg p-4 mb-4 border border-slate-200 bg-white">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <Activity size={16} className="text-slate-600" />
          <h3 className="m-0 text-sm font-bold uppercase tracking-wide text-slate-700">Shift Timeline</h3>
        </div>
        {eventCount > 0 && (
          <span className="text-[11px] font-semibold text-slate-500">
            {eventCount} {eventCount === 1 ? 'event' : 'events'} · {formatDurationShort(totalDowntimeMin)} downtime
          </span>
        )}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-6 text-slate-400">
          <Loader2 size={18} className="animate-spin" />
        </div>
      ) : (
        <>
          <div className="relative h-5 mb-1">
            {hourMarks.filter((m) => m.showLabel).map((m, i, arr) => {
              const isFirst = i === 0;
              const isLast = i === arr.length - 1;
              const translate = isFirst ? 'translate-x-0' : isLast ? '-translate-x-full' : '-translate-x-1/2';
              return (
              <span
                key={i}
                className={`absolute text-[10px] font-semibold text-slate-400 whitespace-nowrap ${translate}`}
                style={{ left: `${m.pct}%` }}
              >
                {m.label}
              </span>
              );
            })}
          </div>

          <div className="relative h-9 rounded-md bg-slate-100 border border-slate-200 overflow-hidden">
            <div
              className="absolute top-0 bottom-0 rounded-l-md"
              style={{
                left: '0%',
                width: `${runWidthPct}%`,
                backgroundColor: RUNNING_COLOR,
              }}
            />

            {hourMarks.map((m, i) => (
              <div
                key={i}
                className="absolute top-0 bottom-0 w-px bg-white/40 z-[5] pointer-events-none"
                style={{ left: `${m.pct}%` }}
              />
            ))}

            {blocks.map((b, i) => (
              <div
                key={i}
                className="absolute top-1 bottom-1 rounded-sm transition-opacity hover:opacity-80 cursor-default"
                style={{
                  left: `${b.leftPct}%`,
                  width: `${b.widthPct}%`,
                  backgroundColor: b.color,
                  minWidth: '3px',
                }}
                title={`${b.label} · ${b.durationLabel}`}
              />
            ))}

            {nowPct !== null && (
              <div
                className="absolute top-0 bottom-0 w-0.5 bg-slate-700 z-10 pointer-events-none"
                style={{ left: `${nowPct}%` }}
              >
                <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-2 h-2 rounded-full bg-slate-700" />
              </div>
            )}
          </div>

          {eventCount === 0 && (
            <p className="text-center text-[11px] text-slate-400 font-medium mt-2 m-0">
              {status === 'not-started'
                ? "Shift hasn't started yet — no events to display."
                : 'No downtime events this shift — clean run.'}
            </p>
          )}
        </>
      )}
    </div>
  );
}
