/*
# Schedule capture-counter via pg_cron

## Purpose
Schedules the capture-counter edge function to run every minute, the same
pattern used for capture-downtime. This captures production counter readings
at each hour mark and on job changes, 24/7, independent of any browser.

1. Changes
- Creates _capture_counter_cron() SECURITY DEFINER function that reads the
  capture-counter URL from app_config and calls it via pg_net.http_get.
- Schedules it every minute as `capture_counter_job`.

2. Security
- No table or RLS changes. Function is SECURITY DEFINER (postgres) for pg_net.
*/

CREATE OR REPLACE FUNCTION _capture_counter_cron()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
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

-- Remove existing job if re-running
DO $$
BEGIN
  PERFORM cron.unschedule(jobid)
  FROM cron.job
  WHERE jobname = 'capture_counter_job';
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

SELECT cron.schedule(
  'capture_counter_job',
  '* * * * *',
  $$ SELECT _capture_counter_cron(); $$
);
