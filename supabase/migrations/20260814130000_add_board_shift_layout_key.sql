-- # Add Board shift layout config key
--
-- Adds the `board_shift_layout` key so admins can switch the Board's
-- production tables between the factory's 2x 12-hour shifts (Morning/Night)
-- and 3x 8-hour shifts (1st 06:00-14:00 / 2nd 14:00-22:00 / 3rd 22:00-06:00).
-- Missing row = default "12h".

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
    'board_transition_ms',
    'board_shift_layout'
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
    'board_transition_ms',
    'board_shift_layout'
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
    'board_transition_ms',
    'board_shift_layout'
  ));

-- Default: 2x 12-hour shifts.
INSERT INTO app_config (key, value)
VALUES ('board_shift_layout', '12h')
ON CONFLICT (key) DO NOTHING;
