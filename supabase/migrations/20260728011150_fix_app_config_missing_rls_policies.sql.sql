/*
# Fix app_config RLS — add missing INSERT and UPDATE policies

The app_config table was created with only a SELECT policy applied.
The INSERT and UPDATE policies exist in the migration file on disk but
were never executed against the database, causing "new row violates
row-level security policy" errors when the settings screen tries to
save the Slack webhook URL.

This migration adds the missing policies so the anon-key frontend
can write config values (single-tenant app, no login screen).
*/

DROP POLICY IF EXISTS "anon_insert_app_config" ON app_config;
CREATE POLICY "anon_insert_app_config" ON app_config FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_app_config" ON app_config;
CREATE POLICY "anon_update_app_config" ON app_config FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);