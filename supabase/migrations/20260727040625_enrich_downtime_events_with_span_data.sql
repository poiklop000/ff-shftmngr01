/*
# Enrich downtime_events with full span history data

## Purpose
The OFS `/server/data/express/spans` endpoint returns the complete historical
downtime record with rich metadata: crew, job, shift, user, comments, reason
category, and more. This migration adds columns to store that enriched data
so the dashboard shows the same level of detail as the OFS tablet.

## New Columns (added to existing `downtime_events` table)
- `span_class` (text) — span class from OFS (e.g. "Downtime")
- `span_type` (text) — detailed span type (e.g. "span.downtime.unplanned")
- `reason_id` (integer) — OFS reason ID
- `reason_category` (integer) — OFS reason category ID
- `reason_category_name` (text) — reason category display name
- `reason_type` (text) — "PLANNED" / "UNPLANNED" from the span
- `crew_id` (integer) — OFS crew/shift team ID
- `crew_name` (text) — crew display name (e.g. "Morning", "Evening")
- `shift_id` (integer) — OFS shift ID
- `shift_start` (bigint) — shift start epoch ms
- `shift_end` (bigint) — shift end epoch ms
- `job_id` (integer) — OFS job ID
- `job_start` (bigint) — job start epoch ms
- `job_end` (bigint) — job end epoch ms
- `job_quantity` (integer) — job target quantity
- `order_id` (integer) — OFS order ID
- `order_quantity` (integer) — order target quantity
- `user_id` (integer) — OFS user who created/edited the span
- `user_name` (text) — user display name
- `comments` (jsonb) — array of comment objects from OFS
- `source` (text) — how the event was captured: 'live' (real-time) or 'history' (backfill/sync)

## Security
- No changes to existing RLS policies (anon + authenticated CRUD already in place).
- New columns are nullable so existing rows are unaffected.

## Notes
- All new columns use `IF NOT EXISTS` guard via DO block so re-running is safe.
- The `source` column lets us distinguish real-time captures from backfilled data.
*/

DO $$
BEGIN
  ALTER TABLE downtime_events ADD COLUMN IF NOT EXISTS span_class text;
  ALTER TABLE downtime_events ADD COLUMN IF NOT EXISTS span_type text;
  ALTER TABLE downtime_events ADD COLUMN IF NOT EXISTS reason_id integer;
  ALTER TABLE downtime_events ADD COLUMN IF NOT EXISTS reason_category integer;
  ALTER TABLE downtime_events ADD COLUMN IF NOT EXISTS reason_category_name text;
  ALTER TABLE downtime_events ADD COLUMN IF NOT EXISTS reason_type text;
  ALTER TABLE downtime_events ADD COLUMN IF NOT EXISTS crew_id integer;
  ALTER TABLE downtime_events ADD COLUMN IF NOT EXISTS crew_name text;
  ALTER TABLE downtime_events ADD COLUMN IF NOT EXISTS shift_id integer;
  ALTER TABLE downtime_events ADD COLUMN IF NOT EXISTS shift_start bigint;
  ALTER TABLE downtime_events ADD COLUMN IF NOT EXISTS shift_end bigint;
  ALTER TABLE downtime_events ADD COLUMN IF NOT EXISTS job_id integer;
  ALTER TABLE downtime_events ADD COLUMN IF NOT EXISTS job_start bigint;
  ALTER TABLE downtime_events ADD COLUMN IF NOT EXISTS job_end bigint;
  ALTER TABLE downtime_events ADD COLUMN IF NOT EXISTS job_quantity integer;
  ALTER TABLE downtime_events ADD COLUMN IF NOT EXISTS order_id integer;
  ALTER TABLE downtime_events ADD COLUMN IF NOT EXISTS order_quantity integer;
  ALTER TABLE downtime_events ADD COLUMN IF NOT EXISTS user_id integer;
  ALTER TABLE downtime_events ADD COLUMN IF NOT EXISTS user_name text;
  ALTER TABLE downtime_events ADD COLUMN IF NOT EXISTS comments jsonb;
  ALTER TABLE downtime_events ADD COLUMN IF NOT EXISTS source text DEFAULT 'live';
END $$;

CREATE INDEX IF NOT EXISTS idx_downtime_events_span_id ON downtime_events(span_id);
CREATE INDEX IF NOT EXISTS idx_downtime_events_crew_id ON downtime_events(crew_id);
CREATE INDEX IF NOT EXISTS idx_downtime_events_job_id ON downtime_events(job_id);
CREATE INDEX IF NOT EXISTS idx_downtime_events_start_epoch ON downtime_events(start_epoch);