/*
# Add Teams alert threshold (minutes)

## Purpose
Adds a configurable "alert threshold" so Teams downtime notifications only
fire after a downtime event has been ongoing for at least N minutes. This
prevents short blips (e.g. a 30-second changeover) from triggering alerts.

Defaults to 10 minutes.

## Changes
1. New app_config key: `teams_alert_threshold_minutes` (text value, default "10")
2. RLS insert/update policies on app_config updated so the frontend settings
   modal can write the new key alongside the existing two Teams keys.
*/

INSERT INTO app_config (key, value)
VALUES ('teams_alert_threshold_minutes', '10')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

DROP POLICY IF EXISTS "anon_insert_app_config" ON app_config;
CREATE POLICY "anon_insert_app_config" ON app_config FOR INSERT
  TO anon, authenticated
  WITH CHECK (key IN ('teams_webhook_url', 'teams_alerts_enabled', 'teams_alert_threshold_minutes'));

DROP POLICY IF EXISTS "anon_update_app_config" ON app_config;
CREATE POLICY "anon_update_app_config" ON app_config FOR UPDATE
  TO anon, authenticated
  USING (key IN ('teams_webhook_url', 'teams_alerts_enabled', 'teams_alert_threshold_minutes'))
  WITH CHECK (key IN ('teams_webhook_url', 'teams_alerts_enabled', 'teams_alert_threshold_minutes'));