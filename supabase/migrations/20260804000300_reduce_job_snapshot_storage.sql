/*
# Reduce job snapshot storage: 5-min cadence + retention purge

## Purpose
Cap database growth. Per-minute job snapshots (~1.2 MB/day) were the main
storage driver; the DB is only needed for daily shift reports, so minute-level
granularity was overkill.

## What changed
- cron job `capture_active_jobs_job` (10): schedule `*/5 * * * *` (every 5
  minutes instead of every minute) — ~0.25 MB/day.
- New cron job `purge_job_snapshots_job` (11): runs daily at 03:05 and deletes
  `job_snapshots` rows older than 180 days via `_purge_job_snapshots()`.

## Notes
- `_purge_job_snapshots()` is a SECURITY DEFINER function (no edge function
  needed — it is a plain SQL DELETE).
- Other tables are bounded: `downtime_events` upserts the same rows, and
  `counter_logs`/`monitoring_records` are tiny.
*/

CREATE OR REPLACE FUNCTION public._purge_job_snapshots()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  DELETE FROM public.job_snapshots
  WHERE capture_time < now() - interval '180 days';
END
$function$;

SELECT cron.alter_job(10, schedule := '*/5 * * * *', active := true);

SELECT cron.schedule('purge_job_snapshots_job', '5 3 * * *', 'SELECT public._purge_job_snapshots();');
