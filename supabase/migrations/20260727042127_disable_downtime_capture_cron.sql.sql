-- Disable the real-time downtime capture cron job.
-- The sync_spans_history cron (every 5 min) now handles all data ingestion
-- by pulling the full event history directly from OFS, so the per-minute
-- real-time capture is no longer needed.

SELECT cron.alter_job(
  job_id => 7,
  schedule => '* * * * *',
  active => false
);
