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
 * Only jobs that were actually running during the shift's exact hours are
 * shown (e.g. the Morning shift 06:00-18:00 does not include jobs from the
 * Night shift). If no jobs were active during that shift window, returns an
 * empty array.
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
  if (!data || data.length === 0) return [];

  const productLines: string[] = [];
  const seenJobIds = new Set<number>();

  for (const row of data as JobSnapshot[]) {
    const jid = row.job_id;
    if (jid === null) continue;
    if (seenJobIds.has(jid)) continue;
    seenJobIds.add(jid);

    const product = row.order_name ?? row.product_name ?? row.sku ?? '';
    if (!product.trim()) continue;
    productLines.push(product.trim());
  }

  return productLines;
}
