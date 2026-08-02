/*
# Store capture-downtime config for the cron job

## Purpose
The pg_cron job needs the edge function URL and anon key to call the
capture-downtime function. Since database-level GUC settings aren't
writable in this environment, we store them in a small config table that
the cron function reads at runtime.

1. New Tables
- `app_config` — key/value store for runtime configuration
  - `key` text primary key
  - `value` text not null
  - `created_at` timestamptz

2. Security
- RLS enabled. Single-tenant (no sign-in): anon + authenticated can read.
- Only the cron function (SECURITY DEFINER, runs as postgres) reads this,
  but we allow read for the frontend too in case it's useful.
*/

CREATE TABLE IF NOT EXISTS app_config (
  key text PRIMARY KEY,
  value text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE app_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_app_config" ON app_config;
CREATE POLICY "anon_select_app_config" ON app_config FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_app_config" ON app_config;
CREATE POLICY "anon_insert_app_config" ON app_config FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_app_config" ON app_config;
CREATE POLICY "anon_update_app_config" ON app_config FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);
