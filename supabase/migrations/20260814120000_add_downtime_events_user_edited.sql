-- # Allow user-corrected setup/slow event durations
--
-- Setup and running-slow durations come from OFS's live feed, whose
-- `span.duration` can lag the true end by up to ~1 minute (OFS only reports the
-- exact value in its hourly summary). This flag marks a downtime_events row
-- that a user has corrected manually (duration + end time). The capture
-- functions skip these rows so the correction is preserved.
--
-- ## Column: downtime_events.user_edited
--   - boolean, default false - true once a user has corrected this event's
--     duration/end time. Automated writers (capture-downtime,
--     sync-spans-history) never update, resolve, supersede, or delete rows
--     with this flag set.

ALTER TABLE downtime_events
  ADD COLUMN IF NOT EXISTS user_edited boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_downtime_events_user_edited
  ON downtime_events (console_id, user_edited);
