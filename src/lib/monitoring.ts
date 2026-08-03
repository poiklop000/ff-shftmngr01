import { supabase } from './supabase';
import { SHIFT_LABELS, parseNumber, type Shift, type ShiftData, type ToggleState } from '@/types';
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
  report_snapshot: string;
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
  reportSnapshot?: string;
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
    report_snapshot: params.reportSnapshot ?? '',
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

export interface ReportSnapshotParams {
  date: string;
  shift: Shift;
  hours: string[];
  boardData: ShiftData;
  notes: string;
  sku: string;
  activeJob: ActiveJobSnapshot | null;
  savedBy?: string;
}

function toggleLabel(state: ToggleState): string {
  return state === 1 ? 'PASS' : state === 2 ? 'ISSUE' : 'N/S';
}

/**
 * Renders the shift board exactly like the printed report, as markdown text.
 * Stored on the monitoring record so saved reports can be viewed later
 * without being loaded back onto the board.
 */
export function buildReportSnapshot(params: ReportSnapshotParams): string {
  const rows = params.boardData.rows;
  const rowCount = Object.keys(rows).length;

  let totalOut = 0;
  let oeeSum = 0;
  let oeeCount = 0;

  const table: string[] = [];
  table.push('| Time | Rated Speed | Actual Output | OEE % | Quality | Safety | Downtime Logs | Filler Yield | Scrap |');
  table.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (let i = 0; i < rowCount; i++) {
    const r = rows[i];
    if (!r) continue;
    const out = parseNumber(r.out);
    const spd = parseNumber(r.spd);
    const oee = out > 0 && spd > 0 ? (out / spd) * 100 : 0;
    totalOut += out;
    if (out > 0 && spd > 0) { oeeSum += oee; oeeCount++; }
    const hour = params.hours[i] ?? '';
    const log = (r.log || '').replace(/\r?\n/g, ' / ');
    table.push(`| ${hour || '-'} | ${r.spd || '0'} | ${r.out || '0'} | ${oee > 0 ? `${oee.toFixed(2)}%` : '0.00%'} | ${toggleLabel(r.q)} | ${toggleLabel(r.s)} | ${log || '-'} | ${r.yld || '-'} | ${r.scr || '-'} |`);
  }
  const avgOee = oeeCount > 0 ? (oeeSum / oeeCount).toFixed(2) : '0.00';

  const skuLines = (params.sku || '').split('\n').filter(Boolean);

  const lines: string[] = [];
  lines.push('# Free-Flow Manufacturing — Krones Canning Line Console');
  lines.push('## Shift Performance Report');
  lines.push('');
  lines.push(`**Shift:** ${SHIFT_LABELS[params.shift]}`);
  lines.push(`**Date:** ${params.date || '-'}`);
  if (params.activeJob) {
    lines.push(`**Active Job:** ${params.activeJob.productName || '-'} (SKU ${params.activeJob.sku || '-'})`);
    lines.push(`**Job Progress:** ${params.activeJob.produced.toLocaleString()} / ${params.activeJob.targetQuantity.toLocaleString()} (${params.activeJob.progress.toFixed(1)}%)`);
  }
  lines.push(`**Saved By:** ${params.savedBy || '-'}`);
  lines.push(`**Saved At:** ${new Date().toLocaleString()}`);
  lines.push('');
  if (skuLines.length > 0) {
    lines.push('## Active Jobs (SKUs)');
    lines.push('');
    skuLines.forEach((job) => {
      const [jobName, ...rest] = job.split('\n');
      lines.push(`- ${jobName} — ${rest.join(' ')}`);
    });
    lines.push('');
  }
  lines.push('## Performance Board');
  lines.push('');
  lines.push(...table);
  lines.push('');
  lines.push(`**Shift Total Output:** ${totalOut.toLocaleString()}`);
  lines.push(`**Shift Average OEE:** ${avgOee}%`);
  lines.push('');
  if ((params.notes || '').trim()) {
    lines.push('## Notes');
    lines.push('');
    lines.push(params.notes.trim());
    lines.push('');
  }
  lines.push('---');
  lines.push('Generated by Web Apps Console v3.00 - Created by Kelvin George');
  return lines.join('\n');
}
