/*
# Add admin-configurable live view refresh intervals

Adds two app_config keys the browser can read and write so an admin can change
the live view's auto-refresh cadence without redeploying:
  - live_refresh_ms          (default "3000")   live/status poll interval
  - live_summary_refresh_ms  (default "30000")  summary + downtime poll interval

The app_config INSERT/UPDATE policies only allow a whitelist of settings keys,
so the two new keys are added to that whitelist (SELECT is already open).

## Safety
- New rows only; no schema changes. Values are bounded to sane ranges in the UI.
*/

INSERT INTO app_config (key, value) VALUES
  ('live_refresh_ms', '3000'),
  ('live_summary_refresh_ms', '30000')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

DROP POLICY IF EXISTS "anon_insert_app_config" ON app_config;
CREATE POLICY "anon_insert_app_config" ON app_config FOR INSERT
  TO anon, authenticated
  WITH CHECK (key IN (
    'teams_webhook_url',
    'teams_alerts_enabled',
    'teams_alert_threshold_minutes',
    'teams_recurring_alerts_enabled',
    'teams_recurring_alert_initial_threshold',
    'live_refresh_ms',
    'live_summary_refresh_ms'
  ));

DROP POLICY IF EXISTS "anon_update_app_config" ON app_config;
CREATE POLICY "anon_update_app_config" ON app_config FOR UPDATE
  TO anon, authenticated
  USING (key IN (
    'teams_webhook_url',
    'teams_alerts_enabled',
    'teams_alert_threshold_minutes',
    'teams_recurring_alerts_enabled',
    'teams_recurring_alert_initial_threshold',
    'live_refresh_ms',
    'live_summary_refresh_ms'
  ))
  WITH CHECK (key IN (
    'teams_webhook_url',
    'teams_alerts_enabled',
    'teams_alert_threshold_minutes',
    'teams_recurring_alerts_enabled',
    'teams_recurring_alert_initial_threshold',
    'live_refresh_ms',
    'live_summary_refresh_ms'
  ));
