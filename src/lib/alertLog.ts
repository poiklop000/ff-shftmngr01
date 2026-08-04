import { supabase } from '@/lib/supabase';
import { withTimeout } from '@/lib/ui';

const DB_TIMEOUT_MS = 15000;

export interface AlertLogRow {
  id: number;
  alert_type: string;
  event_id: number | null;
  reason: string | null;
  category: string | null;
  product: string | null;
  message: string | null;
  status: string;
  http_status: number | null;
  created_at: string;
}

/**
 * Loads the most recent Teams alerts from the alert_log table. Reading is
 * restricted to admins by the admin_select_alert_log RLS policy.
 */
export async function fetchAlertHistory(limit = 100): Promise<AlertLogRow[]> {
  const { data, error } = await withTimeout(
    supabase
      .from('alert_log')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit),
    DB_TIMEOUT_MS,
  );
  if (error) throw new Error(error.message);
  return (data as AlertLogRow[]) ?? [];
}

/**
 * Asks the teams-downtime-alert edge function to send a test card to Teams.
 * Uses the signed-in user's access token (the function requires a valid JWT).
 */
export async function sendTestAlert(): Promise<{ ok: boolean; alerted: number; test?: boolean }> {
  const base = import.meta.env.VITE_SUPABASE_FUNCTIONS_URL
    ?? `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('You must be signed in to send a test alert.');

  const res = await fetch(`${base}/teams-downtime-alert`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ test: true }),
  });
  const body = (await res.json().catch(() => null)) as
    | { ok?: boolean; alerted?: number; error?: string; test?: boolean }
    | null;
  if (!res.ok || body?.ok === false) {
    throw new Error(body?.error ?? `Test alert failed (HTTP ${res.status}).`);
  }
  return { ok: true, alerted: body?.alerted ?? 0, test: body?.test ?? true };
}
