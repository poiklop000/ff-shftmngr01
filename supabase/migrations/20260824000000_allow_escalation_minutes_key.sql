-- Fix app_config RLS: add live_refresh_ms and live_summary_refresh_ms to allowlist.
-- Also includes teams_alert_escalation_minutes added earlier.

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
    'board_shift_layout',
    'ofs_enabled',
    'board_config_county',
    'board_config_site',
    'board_config_line',
    'board_alert_threshold_minutes',
    'alert_configs',
    'live_refresh_interval_ms',
    'live_refresh_ms',
    'live_summary_refresh_ms',
    'ai_model',
    'plateau_threshold_pct'
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
    'board_shift_layout',
    'ofs_enabled',
    'board_config_county',
    'board_config_site',
    'board_config_line',
    'board_alert_threshold_minutes',
    'alert_configs',
    'live_refresh_interval_ms',
    'live_refresh_ms',
    'live_summary_refresh_ms',
    'ai_model',
    'plateau_threshold_pct'
  ))
  WITH CHECK (key IN (
    'teams_webhook_url',
    'teams_alerts_enabled',
    'teams_alert_threshold_minutes',
    'teams_recurring_alerts_enabled',
    'teams_recurring_alert_initial_threshold',
    'teams_alert_escalation_minutes',
    'board_shift_layout',
    'ofs_enabled',
    'board_config_county',
    'board_config_site',
    'board_config_line',
    'board_alert_threshold_minutes',
    'alert_configs',
    'live_refresh_interval_ms',
    'live_refresh_ms',
    'live_summary_refresh_ms',
    'ai_model',
    'plateau_threshold_pct'
  ));
