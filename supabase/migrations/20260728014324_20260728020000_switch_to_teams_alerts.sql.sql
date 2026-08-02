/*
# Switch notifications from Slack to Microsoft Teams

This migration:
1. Renames downtime_events.slack_alerted → alert_sent (preserves data)
2. Renames the pending-downtime index accordingly
3. Replaces Slack config keys with Teams equivalents in app_config
4. Updates the cron function to call the teams-downtime-alert edge function
5. Updates RLS policies so the frontend can write the two new settings keys

NOTE: The old slack_webhook_url / slack_alerts_enabled keys are left in the
table (harmless) so no existing data is lost.
*/

-- 1. Rename the alerted column
ALTER TABLE downtime_events
  RENAME COLUMN slack_alerted TO alert_sent;

-- 2. Recreate the index under the new column name
DROP INDEX IF EXISTS idx_downtime_slack_pending;
CREATE INDEX idx_downtime_alert_pending
  ON downtime_events (start_epoch)
  WHERE resolved = false AND alert_sent = false;

-- 3. Seed Teams config keys
INSERT INTO app_config (key, value)
VALUES ('teams_webhook_url', '')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

INSERT INTO app_config (key, value)
VALUES ('teams_alerts_enabled', 'false')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

INSERT INTO app_config (key, value)
VALUES ('teams_downtime_alert_url',
        'https://dzrtyilgtvrhiilvhyun.supabase.co/functions/v1/teams-downtime-alert')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- 4. Replace the cron function + reschedule
CREATE OR REPLACE FUNCTION public._teams_downtime_alert_cron()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, net
AS $$
DECLARE
  fn_url text;
  anon_key text;
  request_id bigint;
BEGIN
  SELECT value INTO fn_url FROM app_config WHERE key = 'teams_downtime_alert_url';
  SELECT value INTO anon_key FROM app_config WHERE key = 'supabase_anon_key';

  IF fn_url IS NULL OR anon_key IS NULL THEN
    RAISE LOG 'teams_downtime_alert: missing config in app_config table';
    RETURN;
  END IF;

  request_id := net.http_get(
    url := fn_url,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || anon_key,
      'Content-Type', 'application/json'
    )
  );
END $$;

REVOKE EXECUTE ON FUNCTION public._teams_downtime_alert_cron() FROM PUBLIC, anon, authenticated;

-- Unschedule the old Slack cron job and schedule the new Teams one
SELECT cron.unschedule('slack_downtime_alert_job');
SELECT cron.schedule(
  'teams_downtime_alert_job',
  '* * * * *',
  'SELECT public._teams_downtime_alert_cron();'
);

-- 5. Update RLS write policies to allow the two new keys
DROP POLICY IF EXISTS "anon_insert_app_config" ON app_config;
CREATE POLICY "anon_insert_app_config" ON app_config FOR INSERT
  TO anon, authenticated
  WITH CHECK (key IN ('teams_webhook_url', 'teams_alerts_enabled'));

DROP POLICY IF EXISTS "anon_update_app_config" ON app_config;
CREATE POLICY "anon_update_app_config" ON app_config FOR UPDATE
  TO anon, authenticated
  USING (key IN ('teams_webhook_url', 'teams_alerts_enabled'))
  WITH CHECK (key IN ('teams_webhook_url', 'teams_alerts_enabled'));
