import { supabase } from '@/lib/supabase';

export interface LiveIntervals {
  liveMs: number;
  summaryMs: number;
}

const DEFAULT_LIVE_MS = 3000;
const DEFAULT_SUMMARY_MS = 30000;
const MIN_MS = 1000;

function parseMs(value: string | null | undefined, fallback: number): number {
  const n = parseInt(value ?? '', 10);
  if (!Number.isFinite(n) || n < MIN_MS) return fallback;
  return n;
}

export async function loadLiveIntervals(): Promise<LiveIntervals> {
  const { data } = await supabase
    .from('app_config')
    .select('key, value')
    .in('key', ['live_refresh_ms', 'live_summary_refresh_ms']);
  const rows = (data ?? []) as { key: string; value: string | null }[];
  const find = (k: string) => rows.find((r) => r.key === k)?.value;
  return {
    liveMs: parseMs(find('live_refresh_ms'), DEFAULT_LIVE_MS),
    summaryMs: parseMs(find('live_summary_refresh_ms'), DEFAULT_SUMMARY_MS),
  };
}

export async function saveLiveIntervals(liveMs: number, summaryMs: number): Promise<void> {
  const safeLive = Math.max(MIN_MS, Math.round(liveMs));
  const safeSummary = Math.max(MIN_MS, Math.round(summaryMs));
  const upsert = async (key: string, value: string) => {
    const { error } = await supabase
      .from('app_config')
      .upsert({ key, value }, { onConflict: 'key' });
    if (error) throw new Error(error.message);
  };
  await upsert('live_refresh_ms', String(safeLive));
  await upsert('live_summary_refresh_ms', String(safeSummary));
}
