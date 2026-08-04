/*
# Sync downtime history every 5 minutes for timely Teams alerts

## Purpose
Teams downtime alerts read `downtime_events`, which was refreshed only hourly.
At that cadence, OCCURRED alerts fired 10-70 minutes after a downtime started
and RESOLVED alerts were mostly missed (events resolved right after the hourly
sync were detected too late for the 10-minute resolved-alert window).

Running the sync every 5 minutes reduces staleness so:
- OCCURRED alerts fire ~10-15 minutes after start.
- RESOLVED alerts fire within ~5 minutes of the event ending.
- RECURRING issue counts stay fresh.

## What changed
- cron job `sync_spans_history_job` (7): schedule `*/5 * * * *`, active true.
*/

DO $$
DECLARE
  j record;
BEGIN
  FOR j IN
    SELECT jobid, jobname FROM cron.job
    WHERE jobname = 'sync_spans_history_job'
  LOOP
    PERFORM cron.alter_job(j.jobid, schedule := '*/5 * * * *', active := true);
  END LOOP;
END $$;
