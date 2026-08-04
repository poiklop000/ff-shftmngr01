-- # Allow admins to configure escalation + default can rate from the app
--
-- Extends the app_config write allowlist so the Settings screen can edit the
-- alert escalation minutes and the default cans-per-hour used for impact
-- estimates. The teams-downtime-alert edge function already reads these keys.

DROP POLICY IF EXISTS "anon_insert_app_config" ON app_config;
CREATE POLICY "anon_insert_app_config" ON app_config FOR INSERT
  TO anon, authenticated
  WITH CHECK (key IN (
    'teams_webhook_url',
    'teams_alerts_enabled',
    'teams_alert_threshold_minutes',
    'teams_recurring_alerts_enabled',
    'teams_recurring_alert_initial_threshold',
    'teams_alert_escalation_minutes',
    'teams_default_cans_per_hour',
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
    'teams_alert_escalation_minutes',
    'teams_default_cans_per_hour',
    'live_refresh_ms',
    'live_summary_refresh_ms'
  ))
  WITH CHECK (key IN (
    'teams_webhook_url',
    'teams_alerts_enabled',
    'teams_alert_threshold_minutes',
    'teams_recurring_alerts_enabled',
    'teams_recurring_alert_initial_threshold',
    'teams_alert_escalation_minutes',
    'teams_default_cans_per_hour',
    'live_refresh_ms',
    'live_summary_refresh_ms'
  ));
