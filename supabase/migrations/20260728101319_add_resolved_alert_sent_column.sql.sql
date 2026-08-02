-- Add a column to track whether the "resolved" alert has been sent.
-- The existing alert_sent column is repurposed to track the "occurred" alert.
ALTER TABLE downtime_events
  ADD COLUMN IF NOT EXISTS resolved_alert_sent boolean NOT NULL DEFAULT false;