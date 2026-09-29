-- # Restore Board display config keys to the app_config write allowlist
--
-- The 20260820000000 / 20260824000000 policy rewrites accidentally dropped
-- `board_enabled` and `board_transition_ms` (only `board_shift_layout`
-- survived), so the Admin -> Board screen's Save now fails with:
--
--   "new row violates row-level security policy for table "app_config""
--
-- This re-adds both keys to the INSERT/UPDATE policies (using the same full
-- allowlist that the 20260824000000 migration defined, + `board_enabled` +
-- `board_transition_ms`) and ensures the legacy rows exist.

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
    'board_enabled',
    'board_transition_ms',
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
    'board_enabled',
    'board_transition_ms',
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
    'board_enabled',
    'board_transition_ms',
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

-- Defaults: Board shown, 20s view transition (no-op if rows already exist).
INSERT INTO app_config (key, value)
VALUES ('board_enabled', 'true'), ('board_transition_ms', '20000')
ON CONFLICT (key) DO NOTHING;