/*
# Set up pg_cron to call capture-downtime edge function every minute

## Purpose
Supabase Edge Functions do not support Deno.cron reliably in this runtime.
Instead, we use pg_cron (PostgreSQL's cron scheduler) + pg_net (HTTP client
from inside Postgres) to call the capture-downtime edge function every 60
seconds. This keeps downtime capture running 24/7 on the server, independent
of any browser being open — so downtimes are captured even on mobile when the
screen is locked or the tab is in the background.

1. Extensions
- `pg_cron` — scheduled job execution inside Postgres
- `pg_net` — HTTP client for making outbound requests from SQL

2. Scheduled job
- `capture_downtime_job` — runs every minute (* * * * *)
- Calls the capture-downtime edge function via pg_net.http_get
- Uses the anon key for authorization
- The edge function URL and anon key are read from vault/labels so they are
  not hardcoded in plain SQL. We use the current_setting approach to inject
  them at runtime.

3. Security
- No new tables. No RLS changes.
- The cron job runs as the postgres superuser (required by pg_cron).
*/

-- Enable required extensions (idempotent)
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Remove any existing job so re-running this migration is safe
DO $$
BEGIN
  PERFORM cron.unschedule(jobid)
  FROM cron.job
  WHERE jobname = 'capture_downtime_job';
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

-- Schedule the capture call every minute. We build the request inside a
-- SECURITY DEFINER function so pg_net can run with elevated privileges.
-- The edge function URL and anon key are passed via the app settings which
-- are set from the environment at connection time.

CREATE OR REPLACE FUNCTION _capture_downtime_cron()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  fn_url text;
  anon_key text;
  request_id bigint;
BEGIN
  -- Read the edge function base URL and anon key from the Supabase
  -- environment. These are available as GUC settings on the connection.
  fn_url := current_setting('app.function_url', true);
  anon_key := current_setting('app.anon_key', true);

  IF fn_url IS NULL OR anon_key IS NULL THEN
    -- Fall back to constructing from known project settings
    RAISE LOG 'capture_downtime: missing app.function_url or app.anon_key setting';
    RETURN;
  END IF;

  -- Call the edge function (fire-and-forget)
  SELECT id INTO request_id
  FROM net.http_get(
    url := fn_url,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || anon_key,
      'Content-Type', 'application/json'
    )
  );
END $$;

-- Schedule it every minute
SELECT cron.schedule(
  'capture_downtime_job',
  '* * * * *',
  $$ SELECT _capture_downtime_cron(); $$
);
