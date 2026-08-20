-- Allow ai_model and plateau_threshold_pct in app_config INSERT/UPDATE RLS policies.
-- These keys are used by the AI Summary and Job Completion Threshold features.

DROP POLICY IF EXISTS "anon_insert_app_config" ON app_config;
CREATE POLICY "anon_insert_app_config" ON app_config FOR INSERT
  TO anon, authenticated
  WITH CHECK (key IN (
    'teams_webhook_url',
    'teams_alerts_enabled',
    'teams_alert_threshold_minutes',
    'teams_recurring_alerts_enabled',
    'teams_recurring_alert_initial_threshold',
    'board_shift_layout',
    'ofs_enabled',
    'board_config_county',
    'board_config_site',
    'board_config_line',
    'board_alert_threshold_minutes',
    'alert_configs',
    'live_refresh_interval_ms',
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
    'board_shift_layout',
    'ofs_enabled',
    'board_config_county',
    'board_config_site',
    'board_config_line',
    'board_alert_threshold_minutes',
    'alert_configs',
    'live_refresh_interval_ms',
    'ai_model',
    'plateau_threshold_pct'
  ))
  WITH CHECK (key IN (
    'teams_webhook_url',
    'teams_alerts_enabled',
    'teams_alert_threshold_minutes',
    'teams_recurring_alerts_enabled',
    'teams_recurring_alert_initial_threshold',
    'board_shift_layout',
    'ofs_enabled',
    'board_config_county',
    'board_config_site',
    'board_config_line',
    'board_alert_threshold_minutes',
    'alert_configs',
    'live_refresh_interval_ms',
    'ai_model',
    'plateau_threshold_pct'
  ));
