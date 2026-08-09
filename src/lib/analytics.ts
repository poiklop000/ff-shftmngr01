import { supabase } from '@/lib/supabase';
import { withTimeout } from '@/lib/ui';
import { listMonitoringRecords, type MonitoringRecord } from '@/lib/monitoring';
import { localDateTimeToEpoch } from '@/lib/downtime';

const DB_TIMEOUT_MS = 15000;

export interface JobSnapshotRow {
  id: string;
  capture_time: string;
  job_id: number | null;
  product_name: string | null;
  sku: string | null;
  order_name: string | null;
  quantity: number | null;
  produced: number | null;
  progress_pct: number | null;
  run_state: string | null;
  crew_name: string | null;
  shift_name: string | null;
  rated_speed: number | null;
}

/**
 * Fetches job snapshots captured between the given factory-local date/times
 * ("YYYY-MM-DDTHH:mm" strings, inclusive start, exclusive end). Rows are
 * returned oldest-first.
 */
export async function fetchJobsInRange(
  startAt: string,
  endAt: string,
): Promise<JobSnapshotRow[]> {
  const startIso = new Date(localDateTimeToEpoch(startAt)).toISOString();
  const endIso = new Date(localDateTimeToEpoch(endAt)).toISOString();

  // Snapshots are captured continuously (up to once a minute), so a multi-day
  // range can hold thousands of rows. Supabase caps a single request at 1000
  // rows, so page through the whole range — otherwise the oldest 1000 rows are
  // returned and jobs near the end of the range are silently missing.
  const all: JobSnapshotRow[] = [];
  const PAGE = 1000;
  for (let offset = 0; offset < 100000; offset += PAGE) {
    const { data, error } = await withTimeout(
      supabase
        .from('job_snapshots')
        .select('id, capture_time, job_id, product_name, sku, order_name, quantity, produced, progress_pct, run_state, crew_name, shift_name, rated_speed')
        .gte('capture_time', startIso)
        .lt('capture_time', endIso)
        .order('capture_time', { ascending: true })
        .range(offset, offset + PAGE - 1),
      DB_TIMEOUT_MS,
    );
    if (error) throw new Error(error.message);
    const page = (data as JobSnapshotRow[]) ?? [];
    all.push(...page);
    if (page.length < PAGE) break;
  }
  return all;
}

/**
 * Fetches the most recent `rated_speed` captured for each of the given jobs,
 * regardless of the selected date range. Used so the Analytics jobs table
 * shows each job's current rated speed (not the value from an old capture in
 * the range). A user correction in `job_overrides` still takes precedence.
 */
export async function fetchLatestJobRates(jobIds: number[]): Promise<Record<number, number>> {
  if (jobIds.length === 0) return {};
  const { data, error } = await withTimeout(
    supabase
      .from('job_snapshots')
      .select('job_id, rated_speed, capture_time')
      .in('job_id', jobIds)
      .order('capture_time', { ascending: false })
      .limit(1000),
    DB_TIMEOUT_MS,
  );
  if (error) throw new Error(error.message);
  const latest: Record<number, number> = {};
  for (const row of (data as { job_id: number | null; rated_speed: number | null }[]) ?? []) {
    if (row.job_id == null || row.rated_speed == null) continue;
    if (!(row.job_id in latest)) latest[row.job_id] = row.rated_speed;
  }
  return latest;
}

/**
 * Fetches saved monitoring records whose record_date falls within the given
 * range (inclusive). Dates are YYYY-MM-DD.
 */
export async function fetchMonitoringRecordsInRange(
  startDate: string,
  endDate: string,
): Promise<MonitoringRecord[]> {
  const { data, error } = await withTimeout(
    supabase
      .from('monitoring_records')
      .select('*')
      .gte('record_date', startDate)
      .lte('record_date', endDate)
      .order('record_date', { ascending: true })
      .order('shift_name', { ascending: true }),
    DB_TIMEOUT_MS,
  );

  if (error) throw new Error(error.message);
  return (data as MonitoringRecord[]) ?? [];
}

/** Convenience wrapper: one record per date (all shifts). */
export async function fetchMonitoringRecordsByDates(
  dates: string[],
): Promise<MonitoringRecord[]> {
  const results = await Promise.all(dates.map((d) => listMonitoringRecords(d)));
  return results.flat();
}
