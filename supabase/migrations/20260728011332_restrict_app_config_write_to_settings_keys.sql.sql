/*
# Restrict app_config INSERT/UPDATE to settings-only keys

The previous INSERT and UPDATE policies used USING(true)/WITH CHECK(true),
giving the anon client write access to every row including sensitive keys
like supabase_anon_key and internal function URLs.

The browser only legitimately needs to write two keys:
  - slack_webhook_url
  - slack_alerts_enabled

All other rows are written exclusively by migrations (run as postgres/service
role) and should be immutable to the anon-key client.
*/

DROP POLICY IF EXISTS "anon_insert_app_config" ON app_config;
CREATE POLICY "anon_insert_app_config" ON app_config FOR INSERT
  TO anon, authenticated
  WITH CHECK (key IN ('slack_webhook_url', 'slack_alerts_enabled'));

DROP POLICY IF EXISTS "anon_update_app_config" ON app_config;
CREATE POLICY "anon_update_app_config" ON app_config FOR UPDATE
  TO anon, authenticated
  USING (key IN ('slack_webhook_url', 'slack_alerts_enabled'))
  WITH CHECK (key IN ('slack_webhook_url', 'slack_alerts_enabled'));