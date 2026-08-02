/*
# Fix capture-downtime cron function — correct pg_net return type

## Purpose
The previous version of _capture_downtime_cron tried to SELECT a column
named "id" from net.http_get, but pg_net's http_get returns a scalar id
value (an integer), not a record with an id column. This migration fixes
the function to correctly capture the return value.

1. Changes
- Rewrites _capture_downtime_cron() to correctly handle net.http_get's
  scalar return (the request id).

2. Security
- No table or RLS changes. Function remains SECURITY DEFINER.
*/

CREATE OR REPLACE FUNCTION _capture_downtime_cron()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  fn_url text;
  anon_key text;
  req_id bigint;
BEGIN
  SELECT value INTO fn_url FROM app_config WHERE key = 'capture_downtime_url';
  SELECT value INTO anon_key FROM app_config WHERE key = 'supabase_anon_key';

  IF fn_url IS NULL OR anon_key IS NULL THEN
    RAISE LOG 'capture_downtime: missing config in app_config table';
    RETURN;
  END IF;

  -- net.http_get returns a scalar request id (bigint)
  req_id := net.http_get(
    url := fn_url,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || anon_key,
      'Content-Type', 'application/json'
    )
  );
END $$;
