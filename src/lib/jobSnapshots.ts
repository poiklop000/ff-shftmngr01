import { supabase } from '@/lib/supabase';
import { withTimeout } from '@/lib/ui';
import { getActiveHours, type Shift } from '@/types';
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

  const { data, error } = await withTimeout(
    supabase
      .from('job_snapshots')
      .select('capture_time, job_id, product_name, sku, order_name, quantity, produced, run_state')
      .gte('capture_time', startIso)
      .lt('capture_time', endIso)
      .order('capture_time', { ascending: true }),
    DB_TIMEOUT_MS,
  );

  if (error) throw new Error(error.message);
  const rows = (data as JobSnapshot[]) ?? [];
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
