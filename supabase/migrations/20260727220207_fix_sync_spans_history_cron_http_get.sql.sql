/*
# Fix _sync_spans_history_cron: net.http_get returns a scalar, not a composite

## Context
The sync cron function used `SELECT id INTO request_id FROM net.http_get(...)`,
treating the return as a row with an `id` column. pg_net's http_get returns a
scalar bigint (the request id), so this raised "column id does not exist" every
time the cron ran. The capture-downtime cron function was already fixed with the
same pattern — this brings the sync function in line.

## What changed
- `SELECT id INTO request_id FROM net.http_get(...)` →
  `request_id := net.http_get(...)`.
- search_path and EXECUTE grants are unchanged.

## Safety
- No data or schema changes; function body fix only.
*/

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

  request_id := net.http_get(
    url := fn_url,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || anon_key,
      'Content-Type', 'application/json'
    )
  );
END $$;

REVOKE EXECUTE ON FUNCTION public._sync_spans_history_cron() FROM PUBLIC, anon, authenticated;
