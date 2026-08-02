/*
# Set up cron job for spans history sync

## Purpose
Periodically syncs the full downtime event history from OFS's
`/server/data/express/spans` endpoint into the downtime_events table.
This ensures:
- Newly resolved events get their end time and duration updated
- New comments added by operators are synced
- Recent events that weren't captured by the real-time monitor are backfilled

## What changed
1. Insert the sync URL into app_config
2. Create `_sync_spans_history_cron()` function that calls the edge function
3. Schedule it every 5 minutes (faster than the data changes, but not too aggressive)

## Security
- Function is SECURITY DEFINER with execute revoked from PUBLIC/anon/authenticated
- Uses net.http_get with service-level anon key from app_config
*/

INSERT INTO app_config (key, value)
VALUES ('sync_spans_history_url', 'https://dzrtyilgtvrhiilvhyun.supabase.co/functions/v1/sync-spans-history')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

CREATE OR REPLACE FUNCTION public._sync_spans_history_cron()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, net
AS $$
DECLARE
  fn_url text;
  anon_key text;
  request_id bigint;
BEGIN
  SELECT value INTO fn_url FROM app_config WHERE key = 'sync_spans_history_url';
  SELECT value INTO anon_key FROM app_config WHERE key = 'supabase_anon_key';

  IF fn_url IS NULL OR anon_key IS NULL THEN
    RAISE LOG 'sync_spans_history: missing config in app_config table';
    RETURN;
  END IF;

  SELECT id INTO request_id
  FROM net.http_get(
    url := fn_url,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || anon_key,
      'Content-Type', 'application/json'
    )
  );
END $$;

REVOKE EXECUTE ON FUNCTION public._sync_spans_history_cron() FROM PUBLIC, anon, authenticated;

-- Schedule every 5 minutes
SELECT cron.schedule(
  'sync_spans_history_job',
  '*/5 * * * *',
  'SELECT public._sync_spans_history_cron();'
);