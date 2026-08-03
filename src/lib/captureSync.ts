import { supabase } from '@/lib/supabase';

const SYNC_ENDPOINTS = [
  { name: 'downtime', slug: 'sync-spans-history' },
  { name: 'counters', slug: 'capture-counter' },
  { name: 'jobs', slug: 'capture-active-jobs' },
] as const;

export interface SyncResult {
  name: string;
  ok: boolean;
  status?: number;
  error?: string;
}

export interface SyncOutcome {
  results: SyncResult[];
  allOk: boolean;
}

export async function syncAllData(): Promise<SyncOutcome> {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  if (!token) throw new Error('Not signed in.');

  const base = import.meta.env.VITE_SUPABASE_URL;
  const results = await Promise.all(
    SYNC_ENDPOINTS.map(async ({ name, slug }) => {
      try {
        const res = await fetch(`${base}/functions/v1/${slug}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
          return { name, ok: false, status: res.status };
        }
        return { name, ok: true, status: res.status };
      } catch (err) {
        return { name, ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }),
  );

  return { results, allOk: results.every((r) => r.ok) };
}
