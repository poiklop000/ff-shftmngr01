/*
# Counter Logs and Capture State Tables

## Purpose
Stores production counter readings captured from the OFS-X live feed.
Replicates the browser-based auto-capture (hourly counter logging + job-end
capture) on the server so readings are captured 24/7 even when no browser
is open — the same approach we already use for downtime events.

1. New Tables

- `counter_logs`
  - `id`              uuid, primary key
  - `console_id`      text, not null — e.g. "OFS002"
  - `capture_date`    date, not null — the OFS console date (YYYY-MM-DD)
  - `capture_time`    text, not null — HH:MM of the reading (OFS console clock)
  - `counter`         bigint, not null — cumulative filler counter reading
  - `job_id`          integer — OFS job id at capture time
  - `capture_type`    text — "hourly" or "job_end"
  - `console_time`    text — full console timestamp text from OFS
  - `created_at`      timestamptz, default now()
  - Unique constraint on (console_id, capture_date, capture_time) so re-captures
    at the same hour mark upsert instead of duplicating.

- `counter_capture_state`
  - `id`              int, primary key (always 1 — singleton row)
  - `console_id`      text, not null
  - `last_job_id`     integer — last seen OFS job id (for job-end detection)
  - `last_counter`    bigint — last seen counter value
  - `last_captured_hour` text — last hour label captured (e.g. "21:00")
  - `updated_at`      timestamptz, default now()
  - This persists capture state across function invocations (edge functions
    are stateless between requests, so we must store the "last seen" values
    in the database).

2. Indexes
- `idx_counter_logs_date` on (console_id, capture_date, capture_time) — fast
  per-date queries and supports the unique constraint.

3. Security
- RLS enabled on both tables.
- Single-tenant (no sign-in screen): anon + authenticated have full CRUD.
*/

CREATE TABLE IF NOT EXISTS counter_logs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  console_id    text NOT NULL,
  capture_date  date NOT NULL,
  capture_time  text NOT NULL,
  counter       bigint NOT NULL,
  job_id        integer,
  capture_type  text,
  console_time  text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_counter_logs_unique
  ON counter_logs (console_id, capture_date, capture_time);

CREATE INDEX IF NOT EXISTS idx_counter_logs_date
  ON counter_logs (console_id, capture_date DESC);

ALTER TABLE counter_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_counter_logs" ON counter_logs;
CREATE POLICY "anon_select_counter_logs" ON counter_logs FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_counter_logs" ON counter_logs;
CREATE POLICY "anon_insert_counter_logs" ON counter_logs FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_counter_logs" ON counter_logs;
CREATE POLICY "anon_update_counter_logs" ON counter_logs FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_counter_logs" ON counter_logs;
CREATE POLICY "anon_delete_counter_logs" ON counter_logs FOR DELETE
  TO anon, authenticated USING (true);

CREATE TABLE IF NOT EXISTS counter_capture_state (
  id                  int PRIMARY KEY DEFAULT 1,
  console_id          text NOT NULL DEFAULT 'OFS002',
  last_job_id         integer,
  last_counter        bigint,
  last_captured_hour  text,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT singleton CHECK (id = 1)
);

INSERT INTO counter_capture_state (id, console_id)
VALUES (1, 'OFS002')
ON CONFLICT (id) DO NOTHING;

ALTER TABLE counter_capture_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_capture_state" ON counter_capture_state;
CREATE POLICY "anon_select_capture_state" ON counter_capture_state FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_capture_state" ON counter_capture_state;
CREATE POLICY "anon_insert_capture_state" ON counter_capture_state FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_capture_state" ON counter_capture_state;
CREATE POLICY "anon_update_capture_state" ON counter_capture_state FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_capture_state" ON counter_capture_state;
CREATE POLICY "anon_delete_capture_state" ON counter_capture_state FOR DELETE
  TO anon, authenticated USING (true);
