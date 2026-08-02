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

  const { data, error } = await withTimeout(
    supabase
      .from('job_snapshots')
      .select('id, capture_time, job_id, product_name, sku, order_name, quantity, produced, progress_pct, run_state, crew_name, shift_name')
      .gte('capture_time', startIso)
      .lt('capture_time', endIso)
      .order('capture_time', { ascending: true }),
    DB_TIMEOUT_MS,
  );

  if (error) throw new Error(error.message);
  return (data as JobSnapshotRow[]) ?? [];
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
