/*
# Fix _capture_downtime_cron: net.http_get returns a scalar, not a composite

## Context
The downtime cron function used `SELECT id INTO request_id FROM net.http_get(...)`,
treating the return as a row with an `id` column. pg_net's http_get returns a
scalar bigint (the request id), so this raised "column id does not exist" every
time the cron ran. The counter cron function already uses the correct pattern
(direct assignment), so this brings the downtime function in line.

## What changed
- `SELECT id INTO request_id FROM net.http_get(...)` →
  `request_id := net.http_get(...)`.
- search_path and EXECUTE grants are unchanged (still locked down from the
  prior migration).

## Safety
- No data or schema changes; function body fix only.
*/

CREATE OR REPLACE FUNCTION public._capture_downtime_cron()
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
  SELECT value INTO fn_url FROM app_config WHERE key = 'capture_downtime_url';
  SELECT value INTO anon_key FROM app_config WHERE key = 'supabase_anon_key';

  IF fn_url IS NULL OR anon_key IS NULL THEN
    RAISE LOG 'capture_downtime: missing config in app_config table';
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

REVOKE EXECUTE ON FUNCTION public._capture_downtime_cron() FROM PUBLIC, anon, authenticated;
