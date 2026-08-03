/*
# Create monitoring_record_audit table

1. Purpose
   Track every save / overwrite of a monitoring record so the analytics page
   can show who last saved (or overwrote) a record and when. Each row is one
   write to monitoring_records: the first save is action 'create', any later
   save for the same date+shift is action 'overwrite'.

2. New Table: monitoring_record_audit
   - id (uuid, primary key, auto-generated)
   - record_id (uuid, not null) — the monitoring_records.id this write targeted
   - record_date (date, not null) — shift date
   - shift_name (text, not null) — which shift
   - action (text, not null) — 'create' | 'overwrite'
   - saved_by (text, default '') — display name of the user who wrote it
   - created_at (timestamptz, default now()) — when the write happened

3. Security
   - Enable RLS and allow anon/authenticated SELECT + INSERT, matching the
     single-tenant shared-data model used by monitoring_records.
*/

CREATE TABLE IF NOT EXISTS monitoring_record_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  record_id uuid NOT NULL,
  record_date date NOT NULL,
  shift_name text NOT NULL,
  action text NOT NULL CHECK (action IN ('create', 'overwrite')),
  saved_by text DEFAULT '',
  created_at timestamptz DEFAULT now()
);

-- Indexes for fast lookups by record and by date range
CREATE INDEX IF NOT EXISTS idx_monitoring_record_audit_record
  ON monitoring_record_audit (record_id);
CREATE INDEX IF NOT EXISTS idx_monitoring_record_audit_date
  ON monitoring_record_audit (record_date);

-- Enable RLS
ALTER TABLE monitoring_record_audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_monitoring_record_audit" ON monitoring_record_audit;
CREATE POLICY "anon_select_monitoring_record_audit" ON monitoring_record_audit FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_monitoring_record_audit" ON monitoring_record_audit;
CREATE POLICY "anon_insert_monitoring_record_audit" ON monitoring_record_audit FOR INSERT
  TO anon, authenticated WITH CHECK (true);
