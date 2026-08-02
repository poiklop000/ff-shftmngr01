/*
# Fix security findings: function search_path, execute grants, pg_net location, RLS policies

## Overview
Addresses 14 security scanner findings in four groups:

  1. Function Search Path Mutable — _capture_downtime_cron / _capture_counter_cron
     had no fixed search_path, allowing an attacker to influence schema object
     resolution via the caller's search_path.
  2. Public / Signed-In Can Execute SECURITY DEFINER Function — both cron
     functions were callable by anon + authenticated via /rest/v1/rpc/...
     They are meant to run only from the pg_cron scheduler.
  3. Extension in Public — pg_net was installed in the `public` schema.
     Moved to the Supabase-recommended `extensions` schema.
  4. RLS Policy Always True — app_config, counter_capture_state, and
     counter_logs had INSERT/UPDATE/DELETE policies with `true` checks,
     letting any unauthenticated REST caller modify config, capture state,
     and log rows. These policies are removed.

## What changed

### Cron functions (search_path + execute)
Both functions are recreated with `SET search_path = public, extensions` so
schema resolution is pinned. Their bodies now call `extensions.http_get`
explicitly. EXECUTE is revoked from PUBLIC, anon, and authenticated — only the
postgres role used by pg_cron can run them.

### pg_net relocation
The cron jobs are unscheduled and the cron functions dropped first so nothing
depends on pg_net. The extension is then dropped from `public` and recreated in
`extensions`. The cron functions are recreated afterwards and the jobs
re-scheduled. No user data is affected (pg_net only holds transient HTTP
request/response rows that nothing reads).

### RLS policy cleanup
Tables: app_config, counter_capture_state, counter_logs.
  - SELECT policies are KEPT (TO anon, authenticated) — the frontend reads
    these tables via the anon key, so reads must stay open (intentionally
    public single-tenant read pattern).
  - INSERT / UPDATE / DELETE policies are DROPPED. The frontend never writes
    to these tables; all writes come from the edge functions using the service
    role key, which bypasses RLS. Removing the always-true write policies
    closes the REST-API write hole.
downtime_events is left unchanged — its policies already scope writes to a
fixed console_id allowlist (a real predicate, not `true`).

## Safety
  - No tables or columns dropped/renamed. No user data deleted.
  - All policy drops use IF EXISTS; safe to re-run.
  - pg_net drop/recreate is the only non-reversible state change and touches
    only transient HTTP request rows.
*/

-- ----------------------------------------------------------------------
-- 1. Unschedule cron + drop old cron functions so pg_net has no dependents
-- ------------------------------------------------------------------
DO $$
BEGIN
  PERFORM cron.unschedule(jobid)
  FROM cron.job
  WHERE jobname IN ('capture_downtime_job', 'capture_counter_job');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

DROP FUNCTION IF EXISTS public._capture_downtime_cron();
DROP FUNCTION IF EXISTS public._capture_counter_cron();

-- ----------------------------------------------------------------------
-- 2. Move pg_net from public to extensions
-- ------------------------------------------------------------------
DROP EXTENSION IF EXISTS pg_net;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- ----------------------------------------------------------------------
-- 3. Recreate cron functions with fixed search_path, calling extensions.http_get
-- ------------------------------------------------------------------
CREATE FUNCTION public._capture_downtime_cron()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
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
  FROM extensions.http_get(
    url := fn_url,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || anon_key,
      'Content-Type', 'application/json'
    )
  );
END $$;

CREATE FUNCTION public._capture_counter_cron()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
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

  req_id := extensions.http_get(
    url := fn_url,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || anon_key,
      'Content-Type', 'application/json'
    )
  );
END $$;

-- Lock down execute: only the owner (postgres, used by pg_cron) may call these.
REVOKE EXECUTE ON FUNCTION public._capture_downtime_cron() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public._capture_counter_cron() FROM PUBLIC, anon, authenticated;

-- Re-schedule the jobs pointing at the recreated functions.
SELECT cron.schedule(
  'capture_downtime_job',
  '* * * * *',
  $$ SELECT public._capture_downtime_cron(); $$
);

SELECT cron.schedule(
  'capture_counter_job',
  '* * * * *',
  $$ SELECT public._capture_counter_cron(); $$
);

-- ----------------------------------------------------------------------
-- 4. Drop always-true INSERT/UPDATE/DELETE RLS policies
--    SELECT stays open (frontend reads via anon key); writes only happen
--    from edge functions using the service role key, which bypass RLS.
-- ------------------------------------------------------------------

-- app_config
DROP POLICY IF EXISTS "anon_insert_app_config" ON app_config;
DROP POLICY IF EXISTS "anon_update_app_config" ON app_config;

-- counter_capture_state
DROP POLICY IF EXISTS "anon_insert_capture_state" ON counter_capture_state;
DROP POLICY IF EXISTS "anon_update_capture_state" ON counter_capture_state;
DROP POLICY IF EXISTS "anon_delete_capture_state" ON counter_capture_state;

-- counter_logs
DROP POLICY IF EXISTS "anon_insert_counter_logs" ON counter_logs;
DROP POLICY IF EXISTS "anon_update_counter_logs" ON counter_logs;
DROP POLICY IF EXISTS "anon_delete_counter_logs" ON counter_logs;
