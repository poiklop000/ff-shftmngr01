import { supabase } from '@/lib/supabase';
import { withTimeout } from '@/lib/ui';
import { getActiveHours, consoleTimeToShiftMinutes, type Shift } from '@/types';
import { localDateTimeToEpoch } from '@/lib/downtime';

const DB_TIMEOUT_MS = 15000;

export interface JobSnapshot {
  id: string;
  capture_time: string;
  job_id: number | null;
  product_name: string | null;
  sku: string | null;
  order_name: string | null;
  quantity: number | null;
  produced: number | null;
  run_state: string | null;
}

/**
 * Fetches job snapshots from the database for a given date and shift window.
 * Groups them by job_id and returns one product name per distinct job, e.g.
 *   "P-284"
 *   "P-285"
 *
 * Only jobs that were actually producing during the shift's exact hours are
 * shown (e.g. the Morning shift 06:00-18:00 does not include jobs from the
 * Night shift). The OFS console keeps reporting the last finished job while the
 * line is stopped (cleaning/setup), so a job is counted as active only if it
 * was running or its produced count increased during the window. If no jobs
 * were active during that shift window, returns an empty array.
 */
export async function fetchJobsForShift(
  date: string,
  shift: Shift,
  customHours: string[],
): Promise<string[]> {
  if (!date) return [];

  const hours = getActiveHours(shift, customHours);
  if (hours.length === 0) return [];

  // Build the shift's exact wall-clock window (Pacific/Auckland) so the query
  // only returns snapshots captured during this shift's own hours. The start
  // comes from the first interval and the end from the last interval's end,
  // which naturally handles overnight shifts (e.g. 18:00 -> next day 06:00).
  const shiftStartStr = hours[0]!.split(' - ')[0]!.trim();
  const lastInterval = hours[hours.length - 1]!;
  const shiftEndStr = lastInterval.split(' - ')[1]!.trim();
  const isOvernight = parseInt(shiftStartStr.split(':')[0] ?? '0', 10) >= 12;

  let endDate = date;
  if (isOvernight) {
    const d = new Date(`${date}T00:00:00`);
    d.setDate(d.getDate() + 1);
    endDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  const startIso = new Date(localDateTimeToEpoch(`${date}T${shiftStartStr}`)).toISOString();
  const endIso = new Date(localDateTimeToEpoch(`${endDate}T${shiftEndStr}`)).toISOString();

  // Snapshots can be captured up to once a minute, so a long or overnight shift
  // may exceed Supabase's 1000-row-per-request cap. Page through the window so
  // no snapshots (and therefore no jobs) are silently dropped.
  const all: JobSnapshot[] = [];
  const PAGE = 1000;
  for (let offset = 0; offset < 100000; offset += PAGE) {
    const { data, error } = await withTimeout(
      supabase
        .from('job_snapshots')
        .select('capture_time, job_id, product_name, sku, order_name, quantity, produced, run_state')
        .gte('capture_time', startIso)
        .lt('capture_time', endIso)
        .order('capture_time', { ascending: true })
        .range(offset, offset + PAGE - 1),
      DB_TIMEOUT_MS,
    );
    if (error) throw new Error(error.message);
    const page = (data as JobSnapshot[]) ?? [];
    all.push(...page);
    if (page.length < PAGE) break;
  }
  const rows = all;
  if (rows.length === 0) return [];

  const byJob = new Map<number, JobSnapshot[]>();
  for (const row of rows) {
    if (row.job_id === null) continue;
    const list = byJob.get(row.job_id) ?? [];
    list.push(row);
    byJob.set(row.job_id, list);
  }
  if (byJob.size === 0) return [];

  // Older snapshots may predate the run_state column; in that case fall back to
  // showing every distinct job rather than dropping them all.
  const anyRunState = rows.some((r) => !!r.run_state);

  const isActive = (jobRows: JobSnapshot[]): boolean => {
    if (!anyRunState) return true;
    // The job was running at some point during the shift...
    if (jobRows.some((r) => isRunningState(r.run_state))) return true;
    // ...or its produced total increased between snapshots, i.e. the line was
    // actually producing during the shift. A finished job that only lingers on
    // the console during a cleaning/setup keeps a flat produced count and is
    // dropped.
    for (let i = 1; i < jobRows.length; i++) {
      if (toNum(jobRows[i].produced) > toNum(jobRows[i - 1].produced)) return true;
    }
    return false;
  };

  const productLines: string[] = [];
  for (const jobRows of byJob.values()) {
    if (!isActive(jobRows)) continue;
    const last = jobRows[jobRows.length - 1]!;
    const product = last.order_name ?? last.product_name ?? last.sku ?? '';
    if (!product.trim()) continue;
    productLines.push(product.trim());
  }

  return productLines;
}

/**
 * Fetches job snapshots for the given date + shift window and returns a map of
 * row index -> rated speed (cans/hour) for the job that was running in that
 * hour interval. The resolution is per job: each hour is assigned to the job
 * with the most snapshots in it, and that job's user correction (job_overrides
 * from the Live page) is applied when present — so a rated speed changed
 * mid-run still shows up for the whole shift on import, not just for snapshots
 * taken after the correction. When no override exists the snapshot's captured
 * rated speed is used.
 *
 * Hours where the line was not running (idle/cleaning/setup) are left out, so
 * the Monitoring "Import Counter" can fill the Rated Speed column only for
 * hours the line actually produced. If a snapshot has no run_state data (older
 * captures), every hour with a non-null rated speed is filled instead,
 * mirroring fetchJobsForShift's fallback.
 */
export async function fetchHourlyRatedSpeeds(
  date: string,
  shift: Shift,
  customHours: string[],
): Promise<Record<number, number>> {
  if (!date) return {};

  const hours = getActiveHours(shift, customHours);
  if (hours.length === 0) return {};

  // Same wall-clock window logic as fetchJobsForShift so the query only reads
  // snapshots captured during this shift's own hours (overnight shifts span
  // into the next calendar day).
  const shiftStartStr = hours[0]!.split(' - ')[0]!.trim();
  const lastInterval = hours[hours.length - 1]!;
  const shiftEndStr = lastInterval.split(' - ')[1]!.trim();
  const isOvernight = parseInt(shiftStartStr.split(':')[0] ?? '0', 10) >= 12;

  let endDate = date;
  if (isOvernight) {
    const d = new Date(`${date}T00:00:00`);
    d.setDate(d.getDate() + 1);
    endDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  const startIso = new Date(localDateTimeToEpoch(`${date}T${shiftStartStr}`)).toISOString();
  const endIso = new Date(localDateTimeToEpoch(`${endDate}T${shiftEndStr}`)).toISOString();

  interface RatedSpeedRow {
    capture_time: string;
    run_state: string | null;
    job_id: number | null;
    rated_speed: number | null;
  }

  // Snapshots are captured up to once a minute, so page past the 1000-row cap
  // the same way fetchJobsForShift does.
  const all: RatedSpeedRow[] = [];
  const PAGE = 1000;
  for (let offset = 0; offset < 100000; offset += PAGE) {
    const { data, error } = await withTimeout(
      supabase
        .from('job_snapshots')
        .select('capture_time, run_state, job_id, rated_speed')
        .gte('capture_time', startIso)
        .lt('capture_time', endIso)
        .order('capture_time', { ascending: true })
        .range(offset, offset + PAGE - 1),
      DB_TIMEOUT_MS,
    );
    if (error) throw new Error(error.message);
    const page = (data as RatedSpeedRow[]) ?? [];
    all.push(...page);
    if (page.length < PAGE) break;
  }
  if (all.length === 0) return {};

  // User corrections keyed by job. When a job has one, it wins over whatever
  // rated speed the snapshots recorded at capture time.
  const jobIds = new Set<number>();
  for (const r of all) if (r.job_id != null) jobIds.add(r.job_id);

  const overrides = new Map<number, number>();
  if (jobIds.size > 0) {
    const { data: ovr, error: ovrErr } = await withTimeout(
      supabase
        .from('job_overrides')
        .select('job_id, rated_speed')
        .in('job_id', [...jobIds]),
      DB_TIMEOUT_MS,
    );
    if (ovrErr) throw new Error(ovrErr.message);
    for (const o of (ovr ?? []) as Array<{ job_id: number; rated_speed: number | null }>) {
      if (o.rated_speed != null && o.rated_speed > 0) overrides.set(o.job_id, o.rated_speed);
    }
  }

  const anyRunState = all.some((r) => !!r.run_state);
  const shiftStartMin = timeStrToMinutes(shiftStartStr);
  const shiftEndMin = shiftTimeToMinutes(shiftEndStr, shiftStartMin);

  const intervals = hours.map((interval) => {
    const [startStr, endStr] = interval.split(' - ').map((s) => s.trim());
    const start = startStr ?? '';
    const end = endStr ?? start;
    return {
      startMin: shiftTimeToMinutes(start, shiftStartMin),
      endMin: shiftTimeToMinutes(end, shiftStartMin),
    };
  });

  const buckets = new Map<number, Array<{ job_id: number | null; rated_speed: number }>>();
  for (const row of all) {
    if (row.rated_speed == null || row.rated_speed <= 0) continue;
    // Only fill hours the line was actually running. If the snapshots predate
    // the run_state column, accept any non-null rated speed instead.
    if (anyRunState && !isRunningState(row.run_state)) continue;

    const consoleTime = utcIsoToConsoleTime(row.capture_time);
    const min = consoleTimeToShiftMinutes(consoleTime, date);
    if (min < shiftStartMin || min >= shiftEndMin) continue;

    const idx = intervals.findIndex((iv) => min >= iv.startMin && min < iv.endMin);
    if (idx < 0) continue;
    const list = buckets.get(idx) ?? [];
    list.push({ job_id: row.job_id, rated_speed: row.rated_speed });
    buckets.set(idx, list);
  }

  const result: Record<number, number> = {};
  for (const [idx, entries] of buckets) {
    // The job with the most snapshots in this hour is the one that ran it.
    const jobCounts = new Map<number | null, number>();
    for (const e of entries) jobCounts.set(e.job_id, (jobCounts.get(e.job_id) ?? 0) + 1);
    let bestJob: number | null = null;
    let bestJobCount = 0;
    for (const [jid, c] of jobCounts) {
      if (c > bestJobCount) {
        bestJob = jid;
        bestJobCount = c;
      }
    }

    // Most common snapshot rated speed among that job's rows (used when the
    // job has no override).
    let fallback = 0;
    if (bestJob != null) {
      const speedCounts = new Map<number, number>();
      for (const e of entries) {
        if (e.job_id === bestJob) speedCounts.set(e.rated_speed, (speedCounts.get(e.rated_speed) ?? 0) + 1);
      }
      let best = 0;
      let bestCount = 0;
      for (const [s, c] of speedCounts) {
        if (c > bestCount) {
          best = s;
          bestCount = c;
        }
      }
      fallback = best;
    }

    const finalSpeed = bestJob != null && overrides.has(bestJob) ? overrides.get(bestJob)! : fallback;
    if (finalSpeed > 0) result[idx] = finalSpeed;
  }
  return result;
}

function timeStrToMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

// Converts an "HH:MM" wall-clock time to minutes-of-shift-day, rolling times
// before the shift start forward by 1440 (e.g. "00:30" during a 22:00 shift
// becomes minute 1470). Mirrors the private helper in types.ts.
function shiftTimeToMinutes(time: string, shiftStartMin: number): number {
  const min = timeStrToMinutes(time);
  return min < shiftStartMin ? min + 1440 : min;
}

// Converts a UTC ISO capture_time to an OFS console-time string
// ("YYYY-MM-DD HH:MM") in Pacific/Auckland wall-clock, so it can be compared
// against the shift window with the same consoleTimeToShiftMinutes math used
// elsewhere in the app.
function utcIsoToConsoleTime(iso: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Pacific/Auckland',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '0';
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `${get('year')}-${get('month')}-${get('day')} ${hour}:${get('minute')}`;
}

function toNum(v: number | null | undefined): number {
  return typeof v === 'number' && isFinite(v) ? v : 0;
}

// Non-running states mean the line is not producing (even though the console
// may keep showing the last finished job). Checked before RUNNING_RE so a state
// like "Not Running" or "Finished" is never treated as active.
const NOT_RUNNING_RE = /cleaning|setup|set.?up|down|stop|finish|complete|idle|standby|wait|maintenance|maintain|break|lunch|held|hold|error|fault|alarm|pause|not.?running|inactive/i;
const RUNNING_RE = /\b(running|run|producing|production)\b/i;

function isRunningState(state: string | null | undefined): boolean {
  if (!state) return false;
  if (NOT_RUNNING_RE.test(state)) return false;
  return RUNNING_RE.test(state);
}
