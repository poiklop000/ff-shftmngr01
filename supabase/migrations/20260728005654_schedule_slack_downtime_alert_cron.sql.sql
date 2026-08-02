/*
# Schedule Slack downtime alert cron job

## Purpose
Runs the slack-downtime-alert edge function every minute via pg_cron + pg_net
so that downtime events crossing the 10-minute threshold are detected and
notified promptly — even when no browser is open.

## What changed
1. Create `_slack_downtime_alert_cron()` SECURITY DEFINER function that reads
   the edge function URL + anon key from app_config and fires net.http_get.
2. Schedule it every minute (`* * * * *`).

## Security
- SECURITY DEFINER, search_path = public, net. Execute revoked from PUBLIC/anon/authenticated.
- Uses the anon key stored in app_config (same pattern as the existing
  capture-downtime and sync-spans-history cron jobs).
*/

CREATE OR REPLACE FUNCTION public._slack_downtime_alert_cron()
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
  SELECT value INTO fn_url FROM app_config WHERE key = 'slack_downtime_alert_url';
  SELECT value INTO anon_key FROM app_config WHERE key = 'supabase_anon_key';

  IF fn_url IS NULL OR anon_key IS NULL THEN
    RAISE LOG 'slack_downtime_alert: missing config in app_config table';
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

REVOKE EXECUTE ON FUNCTION public._slack_downtime_alert_cron() FROM PUBLIC, anon, authenticated;

SELECT cron.schedule(
  'slack_downtime_alert_job',
  '* * * * *',
  'SELECT public._slack_downtime_alert_cron();'
);