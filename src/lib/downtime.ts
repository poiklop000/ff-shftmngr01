import { fetchExpressSpans, type ExpressSpan } from '@/lib/ofs';
import { supabase } from '@/lib/supabase';
import { withTimeout } from '@/lib/ui';

const DB_TIMEOUT_MS = 15000;

export interface DowntimeComment {
  commentId: number;
  author: string;
  userName: string;
  text: string;
  commentTimestamp: number;
  systemPost: boolean;
  crewName?: string;
}

export interface DowntimeEvent {
  id: number;
  span_id: number;
  state: string | null;
  downtime_type: string | null;
  reason: string | null;
  category: string | null;
  start_epoch: number;
  start_text: string | null;
  end_epoch: number | null;
  duration_ms: number | null;
  resolved: boolean;
  span_class: string | null;
  span_type: string | null;
  reason_id: number | null;
  reason_category: number | null;
  reason_category_name: string | null;
  reason_type: string | null;
  crew_id: number | null;
  crew_name: string | null;
  shift_id: number | null;
  shift_start: number | null;
  shift_end: number | null;
  job_id: number | null;
  job_start: number | null;
  job_end: number | null;
  job_quantity: number | null;
  order_id: number | null;
  order_quantity: number | null;
  user_id: number | null;
  user_name: string | null;
  comments: DowntimeComment[] | null;
}

const CREW_NAMES: Record<number, string> = {
  1: 'Graveyard',
  2: 'Evening',
  3: 'Morning',
};

function crewNameFromId(id?: number): string | null {
  if (id == null || id === 0) return null;
  return CREW_NAMES[id] ?? null;
}

// OFS console is Pacific/Auckland (UTC+12 or UTC+13 during NZDT).
// Format as "YYYY-MM-DD HH:MM:SS.mmm" to match the factory's local time.
function formatEpochConsole(epochMs: number): string {
  const date = new Date(epochMs);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Pacific/Auckland',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  const ms = String(epochMs % 1000).padStart(3, '0');
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}.${ms}`;
}

function spanToEvent(span: ExpressSpan): DowntimeEvent {
  const end = span.end ?? 0;
  const resolved = end > 0;
  const duration = resolved ? end - span.start : Date.now() - span.start;

  let crewId = span.crewId ?? null;
  let crewName: string | null = null;
  if (crewId && crewId > 0) {
    crewName = crewNameFromId(crewId);
  }
  if ((!crewId || crewId === 0) && span.comments && span.comments.length > 0) {
    const first = span.comments[0];
    if (first.crewId && first.crewId > 0) {
      crewId = first.crewId;
      crewName = first.crewName ?? crewNameFromId(first.crewId);
    }
  }

  let userName: string | null = null;
  if (span.comments && span.comments.length > 0) {
    userName = span.comments[0].userName ?? null;
  }

  const comments: DowntimeComment[] | null = span.comments
    ? span.comments.map((c) => ({
        commentId: c.commentId,
        author: c.author,
        userName: c.userName,
        text: c.text,
        commentTimestamp: c.commentTimestamp,
        systemPost: c.systemPost,
        crewName: c.crewName,
      }))
    : null;

  return {
    id: span.id,
    span_id: span.id,
    state: span.spanType ?? null,
    downtime_type: span.reasonType ?? null,
    reason: span.reasonDescription ?? null,
    category: span.reasonCategoryName ?? null,
    start_epoch: span.start,
    start_text: formatEpochConsole(span.start),
    end_epoch: resolved ? end : null,
    duration_ms: duration,
    resolved,
    span_class: span.spanClass ?? null,
    span_type: span.spanType ?? null,
    reason_id: span.reasonId ?? null,
    reason_category: span.reasonCategory ?? null,
    reason_category_name: span.reasonCategoryName ?? null,
    reason_type: span.reasonType ?? null,
    crew_id: crewId,
    crew_name: crewName,
    shift_id: span.shiftId ?? null,
    shift_start: span.shiftStart ?? null,
    shift_end: span.shiftEnd ?? null,
    job_id: span.jobId ?? null,
    job_start: span.jobStart ?? null,
    job_end: span.jobEnd ?? null,
    job_quantity: span.jobQuantity ?? null,
    order_id: span.orderId ?? null,
    order_quantity: span.orderQuantity ?? null,
    user_id: span.userId ?? null,
    user_name: userName,
    comments,
  };
}

// Convert a date string (YYYY-MM-DD) to the start/end epoch range in the
// OFS console timezone (Pacific/Auckland). We build the bounds from the
// date string directly and convert to epoch via Intl, so the browser's
// own timezone doesn't shift the boundary.
function dateToEpochRange(dateStr: string): { start: number; end: number } {
  // Auckland is UTC+12 (standard) / UTC+13 (daylight). To get the epoch for
  // "midnight local" we compute the UTC midnight then subtract the offset.
  // Simplest: use Intl with formatToParts to get the wall-clock, then compute
  // the UTC epoch for that wall clock minus 12h (worst case 13h, but the
  // extra hour only affects events exactly at 11pm-12am boundary which is rare).
  // For correctness we use the actual offset via DateTimeFormat.
  const [y, m, d] = dateStr.split('-').map(Number);
  // Build a date at UTC midnight for the given calendar date
  const utcMidnight = Date.UTC(y, m - 1, d, 0, 0, 0);
  // Auckland offset for that date: format the UTC midnight in Auckland, then
  // compute the difference. If Auckland is ahead, the epoch for Auckland
  // midnight is earlier than UTC midnight.
  const aucklandParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Pacific/Auckland',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(utcMidnight));
  const get = (t: string) => Number(parts_find(aucklandParts, t));
  // The wall-clock in Auckland when UTC = utcMidnight:
  const aucklandHour = get('hour') === 24 ? 0 : get('hour');
  const offsetHours = aucklandHour; // Auckland is ahead by this many hours
  const aucklandMidnightEpoch = utcMidnight - offsetHours * 3600_000;
  const aucklandEndOfDayEpoch = aucklandMidnightEpoch + 24 * 3600_000 - 1;
  return { start: aucklandMidnightEpoch, end: aucklandEndOfDayEpoch };
}

function parts_find(parts: Intl.DateTimeFormatPart[], type: string): string {
  return parts.find((p) => p.type === type)?.value ?? '0';
}

/**
 * Fetches downtime events for a specific date (or date range) directly from OFS.
 * Dates are in YYYY-MM-DD format. If no end date is given, a single day is used.
 *
 * Combines two data sources:
 *   1. data/express/spans — detailed downtime events (unplanned + planned) with
 *      reasons, categories, crew, and comments. This endpoint does NOT return
 *      setup spans.
 *   2. Supabase downtime_events table — setup events captured live by the
 *      capture-downtime edge function. These have precise start/end times and
 *      the real product/changeover reason from OFS.
 */
export async function fetchDowntimeByDate(
  startDate: string,
  endDate?: string,
): Promise<DowntimeEvent[]> {
  const rangeStart = dateToEpochRange(startDate).start;
  const rangeEnd = dateToEpochRange(endDate ?? startDate).end;

  const [spans, setupEvents] = await Promise.all([
    fetchExpressSpans(),
    fetchSetupEventsFromDb(rangeStart, rangeEnd),
  ]);

  const downtimeEvents = spans
    .filter((s) => s.start >= rangeStart && s.start <= rangeEnd)
    .map(spanToEvent);

  return [...downtimeEvents, ...setupEvents]
    .sort((a, b) => b.start_epoch - a.start_epoch);
}

async function fetchSetupEventsFromDb(
  rangeStart: number,
  rangeEnd: number,
): Promise<DowntimeEvent[]> {
  const { data, error } = await withTimeout(
    supabase
      .from('downtime_events')
      .select('*')
      .in('downtime_type', ['SETUP', 'RUNNING_SLOW'])
      .gte('start_epoch', rangeStart)
      .lte('start_epoch', rangeEnd)
      .order('start_epoch', { ascending: false }),
    DB_TIMEOUT_MS,
  );

  if (error || !data) return [];

  return data.map((row) => ({
    id: row.id,
    span_id: row.span_id,
    state: row.state,
    downtime_type: row.downtime_type,
    reason: row.reason,
    category: row.category,
    start_epoch: row.start_epoch,
    start_text: row.start_text,
    end_epoch: row.end_epoch,
    duration_ms: row.duration_ms,
    resolved: row.resolved,
    span_class: row.span_class,
    span_type: row.span_type,
    reason_id: row.reason_id,
    reason_category: row.reason_category,
    reason_category_name: row.reason_category_name,
    reason_type: row.reason_type,
    crew_id: row.crew_id,
    crew_name: row.crew_name,
    shift_id: row.shift_id,
    shift_start: row.shift_start,
    shift_end: row.shift_end,
    job_id: row.job_id,
    job_start: row.job_start,
    job_end: row.job_end,
    job_quantity: row.job_quantity,
    order_id: row.order_id,
    order_quantity: row.order_quantity,
    user_id: row.user_id,
    user_name: row.user_name,
    comments: null,
  }));
}

export function formatDuration(ms: number): string {
  if (!ms || ms <= 0) return '00:00:00';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function formatEventTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString('en-AU', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function formatEventDate(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString('en-AU', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}
