/*
# Create job_snapshots table for active job capture

## Purpose
Stores periodic snapshots of the active OFS job (production run) so there is a
permanent historical record of what was running on the line at any point in
time — product, SKU, target quantity, rated speed, actual output, progress,
job ID, crew, shift, and run state.

Captured automatically every minute by the capture-active-jobs edge function,
independent of any browser being open. Data is kept permanently (no purge).

## Table: job_snapshots
  - id              uuid, primary key
  - console_id      text, not null — e.g. "OFS002"
  - capture_time    timestamptz, not null — when this snapshot was taken
  - job_id          integer — OFS job ID (null if no active job)
  - job_start       bigint — job start epoch ms
  - job_start_text  text — human-readable job start
  - duration_ms     bigint — how long the job has been running
  - quantity        bigint — target quantity
  - produced        bigint — actual output so far (counts.out)
  - rated_speed     integer — rated speed from job metadata
  - progress_pct    numeric — produced / quantity * 100
  - product_name    text — product name from order
  - sku             text — product SKU
  - order_name      text — order name
  - order_client_id text — order client ID
  - run_state       text — current run state name
  - run_state_color text — run state color
  - crew_name       text — crew name
  - shift_name      text — shift name
  - shift_id        integer — shift ID
  - counts          jsonb — raw counter counts
  - metadata        jsonb — raw job metadata (cansPerCarton, etc.)
  - created_at      timestamptz, default now()

No unique constraint — each snapshot is a new row (point-in-time record).

## Security
- RLS enabled.
- Single-tenant app (no sign-in screen): anon + authenticated have full CRUD.
- 4 separate policies per CRUD verb.
*/

CREATE TABLE IF NOT EXISTS job_snapshots (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  console_id      text NOT NULL,
  capture_time    timestamptz NOT NULL DEFAULT now(),
  job_id          integer,
  job_start       bigint,
  job_start_text  text,
  duration_ms     bigint,
  quantity        bigint,
  produced        bigint,
  rated_speed     integer,
  progress_pct    numeric(6,2),
  product_name    text,
  sku             text,
  order_name      text,
  order_client_id text,
  run_state       text,
  run_state_color text,
  crew_name       text,
  shift_name      text,
  shift_id        integer,
  counts          jsonb,
  metadata        jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Indexes for efficient date-range queries
CREATE INDEX IF NOT EXISTS idx_job_snapshots_capture_time
  ON job_snapshots (console_id, capture_time DESC);
CREATE INDEX IF NOT EXISTS idx_job_snapshots_job_id
  ON job_snapshots (console_id, job_id, capture_time DESC);

ALTER TABLE job_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_job_snapshots" ON job_snapshots;
CREATE POLICY "anon_select_job_snapshots" ON job_snapshots FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_job_snapshots" ON job_snapshots;
CREATE POLICY "anon_insert_job_snapshots" ON job_snapshots FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_job_snapshots" ON job_snapshots;
CREATE POLICY "anon_update_job_snapshots" ON job_snapshots FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_job_snapshots" ON job_snapshots;
CREATE POLICY "anon_delete_job_snapshots" ON job_snapshots FOR DELETE
  TO anon, authenticated USING (true);
