-- # Add Board display config keys to the app_config write allowlist
--
-- Adds the `board_enabled` and `board_transition_ms` keys so admins can hide
-- the Board page from navigation and set the Live Status <-> Production table
-- rotation time from the Admin screen. Missing rows = defaults (board shown,
-- 20s view transition).

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
    'ofs_enabled',
    'board_enabled',
    'board_transition_ms'
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
    'ofs_enabled',
    'board_enabled',
    'board_transition_ms'
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
    'ofs_enabled',
    'board_enabled',
    'board_transition_ms'
  ));

-- Defaults: Board shown, 20s view transition.
INSERT INTO app_config (key, value)
VALUES ('board_enabled', 'true'), ('board_transition_ms', '20000')
ON CONFLICT (key) DO NOTHING;
