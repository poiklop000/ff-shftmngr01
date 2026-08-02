/*
# Create monitoring_records table

1. Purpose
   Persist the full shift monitoring board data (rows, notes, SKU) plus
   snapshots of the active job, downtime events, and production counter
   readings for a given date + shift. This gives future data traceability
   so operators can save what they've entered and retrieve it later.

2. New Table: monitoring_records
   - id (uuid, primary key, auto-generated)
   - record_date (date, not null) — the shift date the board was filled in for
   - shift_name (text, not null) — which shift: Morning, Night, 1st, 2nd, 3rd, Custom
   - board_data (jsonb, not null) — the full ShiftData rows (speed, output, downtime log, yield, scrap, quality, safety toggles)
   - notes (text) — free-text shift notes
   - sku (text) — SKU/product info
   - active_job (jsonb) — snapshot of the OFS live job (product, SKU, target qty, rated speed, produced, progress)
   - downtime_snapshot (jsonb) — snapshot of downtime events for that shift window
   - counter_snapshot (jsonb) — snapshot of counter log entries for that shift window
   - saved_by (text) — optional name/identifier of who saved
   - created_at (timestamptz, default now())
   - updated_at (timestamptz, default now())

   A unique constraint on (record_date, shift_name) ensures one record per
   date+shift — saving again for the same date+shift upserts (replaces) the
   previous snapshot.

3. Security
   - Enable RLS on monitoring_records.
   - This is a single-tenant app with no sign-in screen, so policies use
     TO anon, authenticated with USING (true) / WITH CHECK (true) because
     the data is intentionally shared among all console operators.
   - 4 separate policies: SELECT, INSERT, UPDATE, DELETE.

4. Indexes
   - Index on record_date for fast date-based lookups.
   - Index on (record_date, shift_name) for the unique constraint + common query pattern.
*/

CREATE TABLE IF NOT EXISTS monitoring_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  record_date date NOT NULL,
  shift_name text NOT NULL,
  board_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes text DEFAULT '',
  sku text DEFAULT '',
  active_job jsonb DEFAULT '{}'::jsonb,
  downtime_snapshot jsonb DEFAULT '[]'::jsonb,
  counter_snapshot jsonb DEFAULT '[]'::jsonb,
  saved_by text DEFAULT '',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Unique constraint: one record per date + shift
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'monitoring_records_date_shift_key'
  ) THEN
    ALTER TABLE monitoring_records
      ADD CONSTRAINT monitoring_records_date_shift_key UNIQUE (record_date, shift_name);
  END IF;
END $$;

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_monitoring_records_date ON monitoring_records (record_date);
CREATE INDEX IF NOT EXISTS idx_monitoring_records_date_shift ON monitoring_records (record_date, shift_name);

-- Enable RLS
ALTER TABLE monitoring_records ENABLE ROW LEVEL SECURITY;

-- Drop existing policies (idempotent) then recreate
DROP POLICY IF EXISTS "anon_select_monitoring_records" ON monitoring_records;
CREATE POLICY "anon_select_monitoring_records" ON monitoring_records FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_monitoring_records" ON monitoring_records;
CREATE POLICY "anon_insert_monitoring_records" ON monitoring_records FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_monitoring_records" ON monitoring_records;
CREATE POLICY "anon_update_monitoring_records" ON monitoring_records FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_monitoring_records" ON monitoring_records;
CREATE POLICY "anon_delete_monitoring_records" ON monitoring_records FOR DELETE
  TO anon, authenticated USING (true);

-- Auto-update updated_at on row change
CREATE OR REPLACE FUNCTION update_monitoring_records_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_monitoring_records_updated_at ON monitoring_records;
CREATE TRIGGER trg_monitoring_records_updated_at
  BEFORE UPDATE ON monitoring_records
  FOR EACH ROW
  EXECUTE FUNCTION update_monitoring_records_updated_at();
