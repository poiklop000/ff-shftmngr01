import { fetchExpressSpans, type ExpressSpan } from '@/lib/ofs';
import { supabase } from '@/lib/supabase';
import { getActiveHours, type Shift } from '@/types';
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
  user_edited: boolean;
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
    user_edited: false,
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

/**
 * Returns the end of a downtime event as an OFS console-time string in the
 * same "YYYY-MM-DD HH:MM:SS.mmm" format as `start_text`, or null when the
 * event is still running. Used to detect events that started before the
 * current shift window but overlap into it (e.g. a planned stop that began
 * at 04:54 and continues past the 06:00 shift change).
 */
export function downtimeEventEndText(e: DowntimeEvent): string | null {
  if (!e.resolved || e.end_epoch == null) return null;
  return formatEpochConsole(e.end_epoch);
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

// Convert a factory-local wall clock time ("YYYY-MM-DDTHH:mm[:ss]", Pacific/Auckland)
// to its UTC epoch in ms. Handles the timezone offset via Intl, so the browser's
// own timezone does not shift the result.
export function localDateTimeToEpoch(dt: string): number {
  const [datePart, timePart = '00:00'] = dt.split(/[T ]/);
  if (!datePart) return NaN;
  const [y, m, d] = datePart.split('-').map(Number);
  const [hh, mm, ss] = timePart.split(':').map(Number);
  const naiveUtc = Date.UTC(y, m - 1, d, hh || 0, mm || 0, ss || 0);
  if (Number.isNaN(naiveUtc)) return NaN;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Pacific/Auckland',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(naiveUtc));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '0';
  const wallY = Number(get('year'));
  const wallM = Number(get('month'));
  const wallD = Number(get('day'));
  const wallH = get('hour') === '24' ? 0 : Number(get('hour'));
  const wallMin = Number(get('minute'));
  const aucklandAsUtc = Date.UTC(wallY, wallM - 1, wallD, wallH, wallMin, ss || 0);
  const offsetMin = (aucklandAsUtc - naiveUtc) / 60000;
  return naiveUtc - offsetMin * 60000;
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
  return fetchDowntimeBetweenEpochs(rangeStart, rangeEnd);
}

/**
 * Fetches downtime events for a precise factory-local time range
 * ("YYYY-MM-DDTHH:mm" strings). Combines OFS express spans with captured
 * setup/running-slow events from the Supabase downtime_events table.
 */
export async function fetchDowntimeBetween(
  startAt: string,
  endAt: string,
): Promise<DowntimeEvent[]> {
  return fetchDowntimeBetweenEpochs(localDateTimeToEpoch(startAt), localDateTimeToEpoch(endAt));
}

/**
 * Returns the "YYYY-MM-DD" string for the day after the given date.
 */
export function nextDateStr(date: string): string {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Fetches downtime events covering the full window of a shift. Overnight
 * shifts (start hour >= 12, e.g. Night 18:00-06:00) cross midnight, so the
 * following calendar day is fetched too — otherwise events between 00:00 and
 * the end of the shift are missing. Returns events sorted newest-first.
 *
 * Shared by the Monitoring timeline, Import Downtime, and the saved-record
 * snapshot so all three views capture the same set of events.
 */
export async function fetchDowntimeForShift(
  shift: Shift,
  customHours: string[],
  shiftDate: string,
): Promise<DowntimeEvent[]> {
  const hours = getActiveHours(shift, customHours);
  const startStr = hours[0]?.split(' - ')[0]?.trim();
  const isOvernight = startStr ? parseInt(startStr.split(':')[0] ?? '0', 10) >= 12 : false;

  const events = await fetchDowntimeByDate(shiftDate);
  if (isOvernight) {
    const next = await fetchDowntimeByDate(nextDateStr(shiftDate));
    events.push(...next);
    events.sort((a, b) => b.start_epoch - a.start_epoch);
  }
  return events;
}

async function fetchDowntimeBetweenEpochs(
  rangeStart: number,
  rangeEnd: number,
): Promise<DowntimeEvent[]> {
  const [spans, dbEvents] = await Promise.all([
    fetchExpressSpans(rangeStart, rangeEnd),
    fetchDbEventsInEpochRange(rangeStart, rangeEnd),
  ]);

  const downtimeEvents = spans
    .filter((s) => s.start >= rangeStart && s.start <= rangeEnd)
    .map(spanToEvent);

  return [...downtimeEvents, ...dbEvents]
    .sort((a, b) => b.start_epoch - a.start_epoch);
}

async function fetchDbEventsInEpochRange(
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
    user_edited: row.user_edited === true,
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
  // Round to the nearest second so fractional-ms OFS durations display the
  // same number OFS itself shows (e.g. 48:59.865 -> 00:49:00).
  const totalSec = Math.round(ms / 1000);
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
    hour12: false,
  });
}

export function formatEventDate(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString('en-AU', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

// True only for events whose duration/end a user may correct: the two
// live-captured types whose OFS live-feed duration can differ from OFS's true
// figure. Downtime (planned/unplanned) matches OFS exactly via express history.
export function isUserEditableEvent(e: { downtime_type: string | null }): boolean {
  const t = e.downtime_type?.toUpperCase();
  return t === 'SETUP' || t === 'RUNNING_SLOW';
}

// Formats an epoch as an Auckland wall-clock value for a <input type="datetime-local">.
export function epochToLocalInputValue(epochMs: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Pacific/Auckland',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(new Date(epochMs));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `${get('year')}-${get('month')}-${get('day')}T${hour}:${get('minute')}:${get('second')}`;
}

// Formats an epoch as Auckland wall-clock "YYYY-MM-DD HH:MM:SS" (24h military time),
// for the free-text end-time field in the correction modal.
export function epochToLocalMilitaryText(epochMs: number): string {
  return epochToLocalInputValue(epochMs).replace('T', ' ');
}

// Parses a user-entered duration into milliseconds. Accepts "HH:MM:SS",
// "MM:SS", "H:MM", a bare number of minutes, or "Xm Ys". Returns null when the
// text cannot be interpreted.
export function parseDurationInput(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const hmTime = trimmed.match(/^(\d+):([0-5]?\d)(?::([0-5]?\d))?$/);
  if (hmTime) {
    const h = Number(hmTime[1]);
    const m = Number(hmTime[2]);
    const s = Number(hmTime[3] ?? 0);
    if (m > 59 || s > 59) return null;
    return (h * 3600 + m * 60 + s) * 1000;
  }

  const minutes = Number(trimmed.replace(',', '.'));
  if (Number.isFinite(minutes) && minutes >= 0) {
    return Math.round(minutes * 60000);
  }

  return null;
}

interface DowntimeEditMetadata {
  duration_ms?: number | null;
  end_epoch?: number | null;
}

/**
 * Saves a user correction (duration + end time) for a setup/running-slow event.
 * Marks the row `user_edited` so capture-downtime and sync-spans-history leave
 * it alone, and stashes the pre-edit values in `metadata.userEdit` so the user
 * can reset back to the OFS-captured figures later.
 */
export async function correctDowntimeEvent(
  id: number,
  durationMs: number,
  endEpoch: number,
): Promise<void> {
  const { data: row, error: fetchErr } = await supabase
    .from('downtime_events')
    .select('metadata, duration_ms, end_epoch')
    .eq('id', id)
    .maybeSingle();
  if (fetchErr) throw new Error(fetchErr.message);
  if (!row) throw new Error('Downtime event not found.');

  const metadata = (row.metadata ?? {}) as Record<string, unknown>;
  const storedEdit = (metadata.userEdit ?? {}) as DowntimeEditMetadata;

  const { error } = await supabase
    .from('downtime_events')
    .update({
      duration_ms: durationMs,
      end_epoch: endEpoch,
      resolved: true,
      user_edited: true,
      metadata: {
        ...metadata,
        userEdit: {
          duration_ms: storedEdit.duration_ms ?? row.duration_ms ?? null,
          end_epoch: storedEdit.end_epoch ?? row.end_epoch ?? null,
        },
      },
      updated_at: new Date().toISOString(),
    })
    .eq('id', id);
  if (error) throw new Error(error.message);
}

/**
 * Removes a user correction, restoring the OFS-captured duration/end stored at
 * edit time (if any) and unlocking the row so automated capture manages it again.
 */
export async function resetDowntimeEvent(id: number): Promise<void> {
  const { data: row, error: fetchErr } = await supabase
    .from('downtime_events')
    .select('metadata')
    .eq('id', id)
    .maybeSingle();
  if (fetchErr) throw new Error(fetchErr.message);
  if (!row) throw new Error('Downtime event not found.');

  const metadata = (row.metadata ?? {}) as Record<string, unknown>;
  const storedEdit = (metadata.userEdit ?? {}) as DowntimeEditMetadata;
  const patch: Record<string, unknown> = {
    user_edited: false,
    updated_at: new Date().toISOString(),
  };
  if (storedEdit.duration_ms != null) patch.duration_ms = storedEdit.duration_ms;
  if (storedEdit.end_epoch != null) patch.end_epoch = storedEdit.end_epoch;

  const { ...rest } = metadata;
  delete (rest as Record<string, unknown>).userEdit;
  patch.metadata = rest;

  const { error } = await supabase.from('downtime_events').update(patch).eq('id', id);
  if (error) throw new Error(error.message);
}
