import { supabase } from './supabase';
import type { Shift, ShiftData } from '@/types';
import type { OfsLiveStatus } from './ofs';
import type { DowntimeEvent } from './downtime';
import type { CounterLogEntry } from '@/types';

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

export async function saveMonitoringRecord(params: SaveMonitoringParams): Promise<MonitoringRecord> {
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
  return data as MonitoringRecord;
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

export function buildActiveJobSnapshot(status: OfsLiveStatus | null): ActiveJobSnapshot | null {
  if (!status?.job) return null;
  const job = status.job;
  const counts = job.counts ?? {};
  const out = counts.out ?? 0;
  const qty = job.quantity ?? 0;
  const ratedSpeed = job.metadata?.ratedSpeed ? parseInt(job.metadata.ratedSpeed, 10) : 0;
  return {
    productName: job.$order?.$product?.name ?? job.$order?.name ?? '',
    sku: job.$order?.$product?.SKU ?? '',
    targetQuantity: qty,
    ratedSpeed,
    produced: out,
    progress: qty > 0 ? (out / qty) * 100 : 0,
    jobId: job.id ?? null,
    orderName: job.$order?.name ?? null,
  };
}
