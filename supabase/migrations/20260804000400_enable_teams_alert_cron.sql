/*
# Re-enable the Teams downtime alert cron job

## Purpose
The Teams "Send webhook alerts to a channel" workflow webhook is now verified
working (HTTP 202, test card delivered). Re-enable the alert cron so real
OCCURRED / RESOLVED / RECURRING downtime alerts are posted to the channel.

## What changed
- cron job `teams_downtime_alert_job` (9): schedule `* * * * *`, active true.
*/

DO $$
DECLARE
  j record;
BEGIN
  FOR j IN
    SELECT jobid, jobname FROM cron.job
    WHERE jobname = 'teams_downtime_alert_job'
  LOOP
    PERFORM cron.alter_job(j.jobid, active := true);
  END LOOP;
END $$;
