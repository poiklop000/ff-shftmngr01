import { supabase } from '@/lib/supabase';

export type BoardShiftLayout = '12h' | '3x8';

export interface BoardConfig {
  enabled: boolean;
  transitionMs: number;
  shiftLayout: BoardShiftLayout;
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

function parseLayout(value: string | null | undefined): BoardShiftLayout {
  return value === '3x8' ? '3x8' : '12h';
}

export async function loadBoardConfig(): Promise<BoardConfig> {
  const { data } = await supabase
    .from('app_config')
    .select('key, value')
    .in('key', ['board_enabled', 'board_transition_ms', 'board_shift_layout']);
  const rows = (data ?? []) as { key: string; value: string | null }[];
  const find = (k: string) => rows.find((r) => r.key === k)?.value;
  return {
    enabled: parseBool(find('board_enabled'), true),
    transitionMs: parseMs(find('board_transition_ms'), DEFAULT_TRANSITION_MS),
    shiftLayout: parseLayout(find('board_shift_layout')),
  };
}

export async function saveBoardConfig(
  enabled: boolean,
  transitionMs: number,
  shiftLayout: BoardShiftLayout,
): Promise<void> {
  const safeTransition = Math.max(MIN_MS, Math.round(transitionMs));
  const upsert = async (key: string, value: string) => {
    const { error } = await supabase
      .from('app_config')
      .upsert({ key, value }, { onConflict: 'key' });
    if (error) throw new Error(error.message);
  };
  await upsert('board_enabled', String(enabled));
  await upsert('board_transition_ms', String(safeTransition));
  await upsert('board_shift_layout', shiftLayout);
}
