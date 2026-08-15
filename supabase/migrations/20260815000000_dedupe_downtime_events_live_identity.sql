-- # Dedupe duplicate setup/slow events and guard against capture races
--
-- OFS emits the same setup / running-slow event under several overlapping
-- span ids that share a start time (e.g. "job.setup" then "job.setup.running",
-- or "running.slow" then "job.work.running.slow"). capture-downtime normally
-- collapses these to one row per event (identity = console_id + start_epoch +
-- downtime_type), but two runs firing close together can both insert before
-- either sees the other's row, leaving duplicate rows for one event.
--
-- ## 1. Clean up existing duplicates
-- Delete duplicates among live setup/slow rows, keeping the row that best
-- represents the event (resolved-alert sent > longest duration > lowest id).
-- User-edited rows and express-history rows are never touched.
--
-- ## 2. Guard the identity at the database level
-- A partial unique index on (console_id, start_epoch, downtime_type) for
-- source = 'live' setup/slow rows makes the second racing insert fail with a
-- 23505 unique violation. capture-downtime and sync-spans-history catch that
-- conflict and adopt the winning row instead of inserting a duplicate.

WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY console_id, start_epoch, downtime_type
           ORDER BY (resolved_alert_sent = true) DESC, duration_ms DESC NULLS LAST, id
         ) AS rn
  FROM downtime_events
  WHERE source = 'live'
    AND downtime_type IN ('SETUP', 'RUNNING_SLOW')
    AND user_edited = false
)
DELETE FROM downtime_events d
USING ranked r
WHERE d.id = r.id AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS downtime_events_live_identity_idx
  ON downtime_events (console_id, start_epoch, downtime_type)
  WHERE source = 'live' AND downtime_type IN ('SETUP', 'RUNNING_SLOW');
