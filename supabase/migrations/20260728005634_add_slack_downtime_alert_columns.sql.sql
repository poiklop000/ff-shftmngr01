DO $$
BEGIN
  ALTER TABLE downtime_events ADD COLUMN IF NOT EXISTS slack_alerted boolean NOT NULL DEFAULT false;
END $$;

CREATE INDEX IF NOT EXISTS idx_downtime_slack_pending
  ON downtime_events (start_epoch) WHERE resolved = false AND slack_alerted = false;

INSERT INTO app_config (key, value)
VALUES ('slack_alerts_enabled', 'false')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

INSERT INTO app_config (key, value)
VALUES ('slack_downtime_alert_url', 'https://dzrtyilgtvrhiilvhyun.supabase.co/functions/v1/slack-downtime-alert')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;