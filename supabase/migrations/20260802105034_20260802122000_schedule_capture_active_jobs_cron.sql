/*
# Schedule capture-active-jobs via pg_cron

## Purpose
Schedules the capture-active-jobs edge function to run every minute, the same
pattern used for capture-counter. This saves a snapshot of the currently
active OFS job (product, SKU, target, output, progress, crew, shift, run
state) to the job_snapshots table 24/7, independent of any browser.

## What changed
1. Creates _capture_active_jobs_cron() SECURITY DEFINER function that reads
   the capture-active-jobs URL from app_config and calls it via pg_net.http_get.
2. Schedules it every minute as `capture_active_jobs_job`.

## Security
- No table or RLS changes. Function is SECURITY DEFINER (postgres) for pg_net.
- Execute revoked from PUBLIC, anon, authenticated.
*/

CREATE OR REPLACE FUNCTION public._capture_active_jobs_cron()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  fn_url text;
  anon_key text;
  req_id bigint;
BEGIN
  SELECT value INTO fn_url FROM app_config WHERE key = 'capture_active_jobs_url';
  SELECT value INTO anon_key FROM app_config WHERE key = 'supabase_anon_key';

  IF fn_url IS NULL OR anon_key IS NULL THEN
    RAISE LOG 'capture_active_jobs: missing config in app_config table';
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

REVOKE EXECUTE ON FUNCTION public._capture_active_jobs_cron() FROM PUBLIC, anon, authenticated;

-- Remove existing job if re-running
DO $$
BEGIN
  PERFORM cron.unschedule(jobid)
  FROM cron.job
  WHERE jobname = 'capture_active_jobs_job';
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

SELECT cron.schedule(
  'capture_active_jobs_job',
  '* * * * *',
  $cmd$ SELECT public._capture_active_jobs_cron(); $cmd$
);
