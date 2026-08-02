/*
# Stop auto-purging historical data + re-enable counter capture

## Purpose
Keep ALL downtime history, production counter logs, and active job snapshots
permanently — no automatic deletion after 72 hours. Also re-enable the
production counter capture cron job so readings are saved automatically again.

## What changed
1. Unschedule the `purge_old_logs_job` cron job entirely (was deleting
   counter_logs and downtime_events older than 72 hours).
2. Drop the `_purge_old_logs()` function since it is no longer needed.
3. Re-enable the `capture_counter_job` cron job (every minute).
*/

-- 1. Remove the purge job entirely
DO $$
BEGIN
  PERFORM cron.unschedule(jobid)
  FROM cron.job
  WHERE jobname = 'purge_old_logs_job';
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

-- 2. Drop the purge function (no longer needed)
DROP FUNCTION IF EXISTS public._purge_old_logs();

-- 3. Re-enable the counter capture cron job (every minute)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'capture_counter_job') THEN
    PERFORM cron.alter_job(
      job_id => (SELECT jobid FROM cron.job WHERE jobname = 'capture_counter_job'),
      active => true
    );
  ELSE
    PERFORM cron.schedule(
      'capture_counter_job',
      '* * * * *',
      $cmd$ SELECT public._capture_counter_cron(); $cmd$
    );
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'capture_counter_job setup: %', SQLERRM;
END $$;
