-- # Create job_overrides table for user-corrected active job values
--
-- OFS job metadata is sometimes misconfigured (wrong rated speed / product
-- name). This table stores a per-job user correction. When a row exists for a
-- job_id it is layered on top of the OFS data wherever that job is shown or
-- captured — the live Active Job card, saved monitoring reports, and the
-- job_snapshots captured by capture-active-jobs. When no row exists, the
-- original OFS values are used unchanged, so the capture pipeline itself is
-- untouched.
--
-- ## Table: job_overrides
--   - job_id       integer, primary key — OFS job ID of the run being corrected
--   - console_id   text, not null — e.g. "OFS002"
--   - product_name text — corrected product name (null if not overridden)
--   - rated_speed  integer — corrected rated speed in cans/hour (null if not overridden)
--   - created_at   timestamptz, default now()
--   - updated_at   timestamptz, default now()

CREATE TABLE IF NOT EXISTS job_overrides (
  job_id       integer PRIMARY KEY,
  console_id   text NOT NULL DEFAULT 'OFS002',
  product_name text,
  rated_speed  integer,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE job_overrides ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_job_overrides" ON job_overrides;
CREATE POLICY "anon_select_job_overrides" ON job_overrides FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_job_overrides" ON job_overrides;
CREATE POLICY "anon_insert_job_overrides" ON job_overrides FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_job_overrides" ON job_overrides;
CREATE POLICY "anon_update_job_overrides" ON job_overrides FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_job_overrides" ON job_overrides;
CREATE POLICY "anon_delete_job_overrides" ON job_overrides FOR DELETE
  TO anon, authenticated USING (true);
