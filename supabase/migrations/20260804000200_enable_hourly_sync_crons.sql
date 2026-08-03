/*
# Re-enable hourly data sync cron jobs

## Purpose
After the OFS data-extraction pause, restore scheduled syncing of two data
types on an hourly cadence (minute 05 of every hour: 06:05, 07:05, ...):

- sync-spans-history -> downtime events + operator comments into downtime_events
- capture-counter    -> hourly production counter readings into counter_logs

`capture_active_jobs_job` was re-enabled separately (every minute) to rebuild
job history. `capture_downtime_job` and `teams_downtime_alert_job` remain
disabled (the live view reads OFS directly, and Teams alerts stay off).

## What changed
- cron job `sync_spans_history_job` (7): schedule `5 * * * *`, active true.
- cron job `capture_counter_job` (5): schedule `5 * * * *`, active true.
*/

DO $$
DECLARE
  j record;
BEGIN
  FOR j IN
    SELECT jobid, jobname FROM cron.job
    WHERE jobname IN ('sync_spans_history_job', 'capture_counter_job')
  LOOP
    PERFORM cron.alter_job(j.jobid, schedule := '5 * * * *', active := true);
  END LOOP;
END $$;
