/*
# Fix cron functions to call net.http_get (pg_net function location)

## Context
The previous migration (fix_security_findings) moved the pg_net extension
registration into the `extensions` schema to satisfy the "Extension in Public"
scanner finding. However, pg_net still creates its functions in the `net`
schema regardless of where the extension is registered. The cron functions were
updated to call extensions.http_get, which does not exist — they need to call
net.http_get.

## What changed
- Both cron functions now use `SET search_path = public, net` and call
  `net.http_get(...)` with the same signature that worked before the move.
- EXECUTE remains revoked from PUBLIC, anon, authenticated (set in the prior
  migration and preserved here since we use CREATE OR REPLACE).
- The pg_net extension registration stays in `extensions` (scanner-clean).

## Safety
- No data changes. Functions are replaced in place; cron jobs keep running.
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

  SELECT id INTO request_id
  FROM net.http_get(
    url := fn_url,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || anon_key,
      'Content-Type', 'application/json'
    )
  );
END $$;

CREATE OR REPLACE FUNCTION public._capture_counter_cron()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, net
AS $$
DECLARE
  fn_url text;
  anon_key text;
  req_id bigint;
BEGIN
  SELECT value INTO fn_url FROM app_config WHERE key = 'capture_counter_url';
  SELECT value INTO anon_key FROM app_config WHERE key = 'supabase_anon_key';

  IF fn_url IS NULL OR anon_key IS NULL THEN
    RAISE LOG 'capture_counter: missing config in app_config table';
    RETURN;
  END IF;

  req_id := net.http_get(
    url := fn_url,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || anon_key,
      'Content-Type', 'application/json'
    )
  );
END $$;

-- Re-affirm execute lockdown (CREATE OR REPLACE preserves grants, but be explicit).
REVOKE EXECUTE ON FUNCTION public._capture_downtime_cron() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public._capture_counter_cron() FROM PUBLIC, anon, authenticated;
