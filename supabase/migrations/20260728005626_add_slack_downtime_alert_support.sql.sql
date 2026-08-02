/*
# Add Slack downtime alert support

## Purpose
Enables automatic Slack notifications when a downtime event lasts longer than
10 minutes. A scheduled edge function checks for overdue events and posts to
Slack; this migration adds the column and config keys that power it.

## What changed

1. New column on `downtime_events`:
   - `slack_alerted` (boolean, default false) — set to true once a Slack
     notification has been sent for this event, so the same event is never
     alerted twice.

2. New config keys in `app_config`:
   - `slack_webhook_url` — the Slack incoming webhook URL (set by the user
     from the app's Settings screen).
   - `slack_alerts_enabled` — "true" / "false" toggle. Alerts are skipped
     until the user explicitly enables them.
   - `slack_downtime_alert_url` — the edge function URL used by the cron job.

3. New index:
   - `idx_downtime_slack_pending` on (resolved, slack_alerted) WHERE
     resolved = false AND slack_alerted = false — fast lookup of events
     that still need an alert.

## Security
- No changes to existing RLS policies. The new column is writable by the
  same anon + authenticated roles that already have UPDATE access.
- `app_config` already allows anon + authenticated CRUD.
- The webhook URL is stored in app_config. It is readable by the anon-key
  client (single-tenant app, no sign-in). This is acceptable because the
  app is internal and has no login screen. If a login screen is added later,
  the webhook URL row should be restricted to authenticated users only.
*/