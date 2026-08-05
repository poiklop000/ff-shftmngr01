import { supabase } from '@/lib/supabase';

export interface BoardConfig {
  enabled: boolean;
  transitionMs: number;
}

const DEFAULT_TRANSITION_MS = 20000;
const MIN_MS = 1000;

function parseBool(value: string | null | undefined, fallback: boolean): boolean {
  if (value == null) return fallback;
  return value.toLowerCase() === 'true';
}

function parseMs(value: string | null | undefined, fallback: number): number {
  const n = parseInt(value ?? '', 10);
  if (!Number.isFinite(n) || n < MIN_MS) return fallback;
  return n;
}

export async function loadBoardConfig(): Promise<BoardConfig> {
  const { data } = await supabase
    .from('app_config')
    .select('key, value')
    .in('key', ['board_enabled', 'board_transition_ms']);
  const rows = (data ?? []) as { key: string; value: string | null }[];
  const find = (k: string) => rows.find((r) => r.key === k)?.value;
  return {
    enabled: parseBool(find('board_enabled'), true),
    transitionMs: parseMs(find('board_transition_ms'), DEFAULT_TRANSITION_MS),
  };
}

export async function saveBoardConfig(enabled: boolean, transitionMs: number): Promise<void> {
  const safeTransition = Math.max(MIN_MS, Math.round(transitionMs));
  const upsert = async (key: string, value: string) => {
    const { error } = await supabase
      .from('app_config')
      .upsert({ key, value }, { onConflict: 'key' });
    if (error) throw new Error(error.message);
  };
  await upsert('board_enabled', String(enabled));
  await upsert('board_transition_ms', String(safeTransition));
}
