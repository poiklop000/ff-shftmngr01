import { supabase } from './supabase';
import type { Shift, ShiftData } from '@/types';
import type { OfsLiveStatus } from './ofs';
import type { DowntimeEvent } from './downtime';
import type { CounterLogEntry } from '@/types';
import { loadJobOverride } from './jobOverrides';

export interface MonitoringRecord {
  id: string;
  record_date: string;
  shift_name: string;
  board_data: ShiftData;
  notes: string;
  sku: string;
  active_job: ActiveJobSnapshot | null;
  downtime_snapshot: DowntimeEvent[];
  counter_snapshot: CounterLogEntry[];
  hours: string[];
  saved_by: string;
  created_at: string;
  updated_at: string;
}

export interface ActiveJobSnapshot {
  productName: string;
  sku: string;
  targetQuantity: number;
  ratedSpeed: number;
  produced: number;
  progress: number;
  jobId: number | null;
  orderName: string | null;
}

export interface SaveMonitoringParams {
  date: string;
  shift: Shift;
  boardData: ShiftData;
  notes: string;
  sku: string;
  activeJob: ActiveJobSnapshot | null;
  downtimeSnapshot: DowntimeEvent[];
  counterSnapshot: CounterLogEntry[];
  hours?: string[];
  savedBy?: string;
}

export interface MonitoringRecordAudit {
  id: string;
  record_id: string;
  record_date: string;
  shift_name: string;
  action: 'create' | 'overwrite';
  saved_by: string;
  created_at: string;
}

export async function saveMonitoringRecord(params: SaveMonitoringParams): Promise<MonitoringRecord> {
  // Determine whether this write creates a new record or overwrites an
  // existing one for the same date + shift so the audit log can tell them apart.
  const existing = await loadMonitoringRecord(params.date, params.shift);

  const payload = {
    record_date: params.date,
    shift_name: params.shift,
    board_data: params.boardData,
    notes: params.notes,
    sku: params.sku,
    active_job: params.activeJob ?? {},
    downtime_snapshot: params.downtimeSnapshot,
    counter_snapshot: params.counterSnapshot,
    hours: params.hours ?? [],
    saved_by: params.savedBy ?? '',
  };

  const { data, error } = await supabase
    .from('monitoring_records')
    .upsert(payload, { onConflict: 'record_date,shift_name' })
    .select()
    .single();

  if (error) throw new Error(error.message);
  const record = data as MonitoringRecord;

  // Best-effort audit trail: never fail the save because the audit insert failed.
  try {
    await supabase.from('monitoring_record_audit').insert({
      record_id: record.id,
      record_date: params.date,
      shift_name: params.shift,
      action: existing ? 'overwrite' : 'create',
      saved_by: params.savedBy ?? '',
    });
  } catch {
    // ignore audit logging errors
  }

  return record;
}

export async function fetchRecordAudit(recordId: string): Promise<MonitoringRecordAudit[]> {
  const { data, error } = await supabase
    .from('monitoring_record_audit')
    .select('*')
    .eq('record_id', recordId)
    .order('created_at', { ascending: false });

  if (error) throw new Error(error.message);
  return (data as MonitoringRecordAudit[]) ?? [];
}

export async function loadMonitoringRecord(date: string, shift: Shift): Promise<MonitoringRecord | null> {
  const { data, error } = await supabase
    .from('monitoring_records')
    .select('*')
    .eq('record_date', date)
    .eq('shift_name', shift)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return (data as MonitoringRecord) ?? null;
}

export async function listMonitoringRecords(date: string): Promise<MonitoringRecord[]> {
  const { data, error } = await supabase
    .from('monitoring_records')
    .select('*')
    .eq('record_date', date)
    .order('shift_name', { ascending: true });

  if (error) throw new Error(error.message);
  return (data as MonitoringRecord[]) ?? [];
}

export async function deleteMonitoringRecord(date: string, shift: Shift): Promise<void> {
  const { error } = await supabase
    .from('monitoring_records')
    .delete()
    .eq('record_date', date)
    .eq('shift_name', shift);

  if (error) throw new Error(error.message);
}

export async function buildActiveJobSnapshot(status: OfsLiveStatus | null): Promise<ActiveJobSnapshot | null> {
  if (!status?.job) return null;
  const job = status.job;
  const jobId = job.id ?? null;

  // Layer a user correction (if any) on top of the OFS data. A network failure
  // here falls back to the raw OFS values so a saved report is never blocked.
  const override = jobId != null ? await loadJobOverride(jobId).catch(() => null) : null;

  const counts = job.counts ?? {};
  // "Produced" = filler output: units through the line / units in to the
  // process, matching the Live page. `counts.out` is the date-coder counter,
  // which can freeze when a downstream machine stops while the filler keeps
  // producing.
  const out = counts.through || status.process?.unitsin?.value || counts.out || 0;
  const qty = job.quantity ?? 0;
  const ofsRated = job.metadata?.ratedSpeed ? parseInt(job.metadata.ratedSpeed, 10) : 0;
  const ratedSpeed = override?.rated_speed ?? ofsRated;
  const ofsName = job.$order?.$product?.name ?? job.$order?.name ?? '';
  const productName = override?.product_name?.trim() || ofsName;

  return {
    productName,
    sku: job.$order?.$product?.SKU ?? '',
    targetQuantity: qty,
    ratedSpeed,
    produced: out,
    progress: qty > 0 ? (out / qty) * 100 : 0,
    jobId,
    orderName: job.$order?.name ?? null,
  };
}
