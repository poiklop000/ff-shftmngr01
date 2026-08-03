/*
# Disable all scheduled auto-capture and alert cron jobs

## Purpose
Stop the per-minute automated data ingestion (capture-downtime,
capture-counter, capture-active-jobs) and the downtime alert notifier
(teams-downtime-alert) while OFS data extraction is being arranged with the
vendor. Data is now pulled on demand via the app's "Sync Data" button, which
calls the same edge functions manually. The live view is unaffected — it reads
OFS directly and needs no cron.

## What changed
- Sets `active := false` on every known capture/alert job by name, so it is
  immune to pg_cron job id drift. Jobs are preserved (not unscheduled) so they
  can be re-enabled later with `cron.alter_job(..., active := true)`.

## Re-enabling
    DO $$ DECLARE j record; BEGIN
      FOR j IN SELECT jobid FROM cron.job
        WHERE jobname IN ('capture_downtime_job','capture_counter_job',
                          'sync_spans_history_job','capture_active_jobs_job',
                          'teams_downtime_alert_job') LOOP
        PERFORM cron.alter_job(j.jobid, schedule := '* * * * *', active := true);
      END LOOP;
    END $$;

## Safety
- No table, data or RLS changes. Jobs simply stop firing.
*/

DO $$
DECLARE
  j record;
BEGIN
  FOR j IN
    SELECT jobid FROM cron.job
    WHERE jobname IN (
      'capture_downtime_job',
      'capture_counter_job',
      'sync_spans_history_job',
      'capture_active_jobs_job',
      'teams_downtime_alert_job'
    )
  LOOP
    PERFORM cron.alter_job(j.jobid, schedule := '* * * * *', active := false);
  END LOOP;
END $$;
