/*
# Auto-delete log data older than 72 hours

## Purpose
Keeps the database from growing indefinitely. A scheduled job runs daily and
deletes rows older than 72 hours from the two tables that accumulate over time:
`counter_logs` and `downtime_events`. The control tables (`app_config`,
`counter_capture_state`) are single-row and are NOT touched.

## What changed

### New function: _purge_old_logs()
SECURITY DEFINER function with a pinned search_path that deletes:
  - counter_logs rows whose `created_at` is older than 72 hours
  - downtime_events rows whose `created_at` is older than 72 hours

Both deletes are plain DELETEs guarded by a timestamp comparison — no table or
column is dropped, no data younger than 72h is affected.

### Scheduled job: purge_old_logs_job
Runs once per day at 03:00 server time (cron `0 3 * * *`). Running daily is
sufficient because the retention window is 72 hours — a day of drift never
pushes us over the limit in a way that matters, and it keeps load low.

### Execute lockdown
EXECUTE on the purge function is revoked from PUBLIC, anon, and authenticated
so it can only be invoked by the postgres role (used by pg_cron), not via the
REST API.

## Safety
  - Only rows older than 72 hours are deleted. Recent data is untouched.
  - The function is idempotent and safe to re-run.
  - Uses `created_at` (timestamptz) on both tables, which always exists and is
    set automatically on insert.
*/

CREATE OR REPLACE FUNCTION public._purge_old_logs()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  cutoff timestamptz := now() - interval '72 hours';
  deleted_logs int;
  deleted_downtime int;
BEGIN
  DELETE FROM counter_logs WHERE created_at < cutoff;
  GET DIAGNOSTICS deleted_logs = ROW_COUNT;

  DELETE FROM downtime_events WHERE created_at < cutoff;
  GET DIAGNOSTICS deleted_downtime = ROW_COUNT;

  RAISE LOG 'purge_old_logs: cutoff=%, counter_logs=%, downtime_events=%',
    cutoff, deleted_logs, deleted_downtime;
END $$;

REVOKE EXECUTE ON FUNCTION public._purge_old_logs() FROM PUBLIC, anon, authenticated;

-- Remove any existing job so re-running is safe
DO $$
BEGIN
  PERFORM cron.unschedule(jobid)
  FROM cron.job
  WHERE jobname = 'purge_old_logs_job';
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

-- Run daily at 03:00
SELECT cron.schedule(
  'purge_old_logs_job',
  '0 3 * * *',
  $$ SELECT public._purge_old_logs(); $$
);

-- Run once now to clear any existing old data immediately
SELECT public._purge_old_logs();
