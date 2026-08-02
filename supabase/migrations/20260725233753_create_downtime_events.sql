/*
# Downtime Events Table

## Purpose
Stores historical downtime events captured from the OFS-X live feed.
The live/spans endpoint exposes only the *current* downtime; by polling it
regularly and upserting each downtime event we build our own searchable
history that can be filtered by date — replicating the "Events" popup on
the OFS-X live screen without needing the browser-session-protected
events endpoint.

1. New Tables
- `downtime_events`
  - `id`              integer, primary key — the OFS-X span id (stable, unique per event)
  - `console_id`      text, not null — e.g. "OFS002"
  - `console_name`    text — human-readable line name, e.g. "Krones Canning Line"
  - `span_id`         integer — OFS-X internal span id (same as id, kept for clarity)
  - `state`           text — e.g. "span.downtime.unplanned"
  - `downtime_type`   text — "UNPLANNED" / "PLANNED" / "SETUP"
  - `reason`          text — human-readable reason, e.g. "Waiting for Tank to be cleared by QA"
  - `category`        text — reason category, e.g. "Administration"
  - `start_epoch`     bigint — epoch milliseconds (from OFS-X `start`)
  - `start_text`      text — formatted timestamp string from OFS-X
  - `end_epoch`       bigint — epoch ms when the downtime ended (null while ongoing)
  - `duration_ms`     bigint — duration in milliseconds (updated each poll while ongoing)
  - `resolved`        boolean, default false — true once the downtime has ended
  - `counts`          jsonb — OFS-X counts snapshot at capture time
  - `metadata`        jsonb — extra OFS-X fields (crew, user, etc.)
  - `created_at`      timestamptz, default now()
  - `updated_at`      timestamptz, default now()

2. Indexes
- `idx_downtime_console_start` on (console_id, start_epoch DESC) — fast date-range queries per console
- `idx_downtime_unresolved` on (console_id) WHERE resolved = false — fast lookup of open events for upsert

3. Security
- RLS enabled.
- Single-tenant (no sign-in screen): anon + authenticated have full CRUD.
  The frontend polls live/spans via the edge function and writes events;
  the same frontend reads them back for the history view.
*/

CREATE TABLE IF NOT EXISTS downtime_events (
  id            bigint PRIMARY KEY,
  console_id    text NOT NULL,
  console_name  text,
  span_id       integer,
  state         text,
  downtime_type text,
  reason        text,
  category      text,
  start_epoch   bigint NOT NULL,
  start_text    text,
  end_epoch     bigint,
  duration_ms   bigint,
  resolved      boolean NOT NULL DEFAULT false,
  counts        jsonb,
  metadata      jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_downtime_console_start
  ON downtime_events (console_id, start_epoch DESC);

CREATE INDEX IF NOT EXISTS idx_downtime_unresolved
  ON downtime_events (console_id) WHERE resolved = false;

ALTER TABLE downtime_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_downtime" ON downtime_events;
CREATE POLICY "anon_select_downtime" ON downtime_events FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_downtime" ON downtime_events;
CREATE POLICY "anon_insert_downtime" ON downtime_events FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_downtime" ON downtime_events;
CREATE POLICY "anon_update_downtime" ON downtime_events FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_downtime" ON downtime_events;
CREATE POLICY "anon_delete_downtime" ON downtime_events FOR DELETE
  TO anon, authenticated USING (true);
