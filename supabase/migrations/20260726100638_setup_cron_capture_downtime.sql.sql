/*
# Schedule capture-downtime via pg_cron

## Purpose
Supabase Edge Functions do not support Deno.cron reliably in this runtime.
Instead, we use pg_cron + pg_net to call the capture-downtime edge function
every 60 seconds. This keeps downtime capture running 24/7 on the server,
independent of any browser being open — so downtimes are captured even on
mobile when the screen is locked or the tab is in the background.

1. Extensions
- `pg_cron` — scheduled job execution inside Postgres
- `pg_net` — HTTP client for making outbound requests from SQL

2. Scheduled job
- `capture_downtime_job` — runs every minute (* * * * *)
- Calls the capture-downtime edge function via pg_net.http_get
- Reads the function URL and anon key from the app_config table

3. Security
- No new tables. No RLS changes.
- The cron function runs as SECURITY DEFINER (postgres) so it can use pg_net.
*/

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Remove any existing job so re-running is safe
DO $$
BEGIN
  PERFORM cron.unschedule(jobid)
  FROM cron.job
  WHERE jobname = 'capture_downtime_job';
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

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

SELECT cron.schedule(
  'capture_downtime_job',
  '* * * * *',
  $$ SELECT _capture_downtime_cron(); $$
);
