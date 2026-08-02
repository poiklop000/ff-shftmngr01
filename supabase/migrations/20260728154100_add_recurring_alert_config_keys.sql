/*
# Add recurring issue alert config keys

## Purpose
Adds two new app_config keys so the recurring issue alert feature can be
toggled and its threshold configured from the Settings screen:

1. `teams_recurring_alerts_enabled` — "true" / "false" toggle. When false,
   recurring issue alerts are skipped entirely. Defaults to "false" so the
   feature is opt-in.
2. `teams_recurring_alert_initial_threshold` — the count at which the first
   alert fires (default "5"). Subsequent alerts fire at +2 intervals
   (7, 9, 11...).

## What changed
1. Seeds the two new config keys in app_config with defaults.
2. Updates RLS insert/update policies on app_config to include the new keys
   alongside the existing Teams alert keys.

## Security
- Same single-tenant pattern: anon + authenticated can read/write these keys.
- No changes to existing policies beyond adding the new keys to the allowed list.
*/

INSERT INTO app_config (key, value)
VALUES ('teams_recurring_alerts_enabled', 'false')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

INSERT INTO app_config (key, value)
VALUES ('teams_recurring_alert_initial_threshold', '5')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

DROP POLICY IF EXISTS "anon_insert_app_config" ON app_config;
CREATE POLICY "anon_insert_app_config" ON app_config FOR INSERT
  TO anon, authenticated
  WITH CHECK (key IN (
    'teams_webhook_url',
    'teams_alerts_enabled',
    'teams_alert_threshold_minutes',
    'teams_recurring_alerts_enabled',
    'teams_recurring_alert_initial_threshold'
  ));

DROP POLICY IF EXISTS "anon_update_app_config" ON app_config;
CREATE POLICY "anon_update_app_config" ON app_config FOR UPDATE
  TO anon, authenticated
  USING (key IN (
    'teams_webhook_url',
    'teams_alerts_enabled',
    'teams_alert_threshold_minutes',
    'teams_recurring_alerts_enabled',
    'teams_recurring_alert_initial_threshold'
  ))
  WITH CHECK (key IN (
    'teams_webhook_url',
    'teams_alerts_enabled',
    'teams_alert_threshold_minutes',
    'teams_recurring_alerts_enabled',
    'teams_recurring_alert_initial_threshold'
  ));