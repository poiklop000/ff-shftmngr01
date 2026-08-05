-- # Add OFS kill-switch config key to the app_config write allowlist
--
-- Adds the master `ofs_enabled` flag so admins can stop ALL data traffic to/from
-- OFS in one click from the Admin screen. When set to "false", every edge
-- function that talks to OFS (live proxy reads + scheduled capture/sync crons)
-- short-circuits before contacting the OFS server. Missing row = enabled.

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
    'live_summary_refresh_ms',
    'ofs_enabled'
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
    'live_summary_refresh_ms',
    'ofs_enabled'
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
    'live_summary_refresh_ms',
    'ofs_enabled'
  ));

-- Default: OFS traffic allowed. Safe even on projects that already ran the
-- earlier allowlist migrations, because the policies above are recreated last.
INSERT INTO app_config (key, value)
VALUES ('ofs_enabled', 'true')
ON CONFLICT (key) DO NOTHING;
