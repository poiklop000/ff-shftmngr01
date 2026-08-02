import { supabase } from '@/lib/supabase';
import { withTimeout } from '@/lib/ui';
import { listMonitoringRecords, type MonitoringRecord } from '@/lib/monitoring';

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

// Convert a YYYY-MM-DD factory date to the epoch of local Auckland midnight,
// so date-range queries on UTC timestamps line up with the console calendar.
function aucklandMidnightEpoch(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  const utcMidnight = Date.UTC(y, m - 1, d, 0, 0, 0);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Pacific/Auckland',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(utcMidnight));
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const offsetHours = hour === 24 ? 0 : hour;
  return utcMidnight - offsetHours * 3600_000;
}

/**
 * Fetches job snapshots captured between the given factory dates
 * (inclusive). Dates are YYYY-MM-DD. Rows are returned oldest-first.
 */
export async function fetchJobsInRange(
  startDate: string,
  endDate: string,
): Promise<JobSnapshotRow[]> {
  const startIso = new Date(aucklandMidnightEpoch(startDate)).toISOString();
  const endIso = new Date(aucklandMidnightEpoch(endDate) + 24 * 3600_000).toISOString();

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
