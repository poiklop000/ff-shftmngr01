/*
# Recurring Issue Alerts Table

## Purpose
Tracks the last alerted threshold for recurring downtime issues so the
escalating-threshold alert system knows when to re-fire.

When 5 downtimes with the SAME reason + category occur within a rolling
1-hour window, a Teams notification is sent. The alert re-fires at
escalating thresholds: 5, 7, 9, 11, ... (every +2 occurrences). This
table records the last threshold that was alerted so each threshold only
fires once.

1. New Tables
- `recurring_issue_alerts`
  - `id`                  uuid, primary key
  - `reason`              text, not null — the downtime reason text
  - `category`            text, not null — the downtime category
  - `last_threshold`      integer, not null — the last threshold count
                          that an alert was sent at (e.g. 5, 7, 9...)
  - `last_alerted_at`     timestamptz, not null — when the last alert fired
  - `occurrence_count`    integer, not null — the count in the window at
                          the time the last alert was sent (for context)
  - `created_at`          timestamptz, default now()
  - `updated_at`          timestamptz, default now()

2. Indexes
- `idx_recurring_alerts_reason_category` UNIQUE on (reason, category) —
  ensures one tracking row per reason+category cluster.

3. Security
- RLS enabled.
- Single-tenant (no sign-in screen): anon + authenticated have full CRUD,
  matching the existing downtime_events and app_config policies.

4. How it works
- The teams-downtime-alert edge function counts downtime_events from the
  last 60 minutes grouped by reason + category.
- For each group whose count >= 5, it checks this table for the last
  alerted threshold.
- If count >= last_threshold + 2 (or count >= 5 with no existing row),
  it sends a Teams notification and updates last_threshold.
- Rows whose last_alerted_at falls outside the 1-hour window are
  considered stale and the count starts fresh from threshold 5.
*/

CREATE TABLE IF NOT EXISTS recurring_issue_alerts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reason           text NOT NULL,
  category         text NOT NULL,
  last_threshold   integer NOT NULL,
  last_alerted_at  timestamptz NOT NULL,
  occurrence_count integer NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_recurring_alerts_reason_category
  ON recurring_issue_alerts (reason, category);

ALTER TABLE recurring_issue_alerts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_recurring_alerts" ON recurring_issue_alerts;
CREATE POLICY "anon_select_recurring_alerts" ON recurring_issue_alerts FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_recurring_alerts" ON recurring_issue_alerts;
CREATE POLICY "anon_insert_recurring_alerts" ON recurring_issue_alerts FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_recurring_alerts" ON recurring_issue_alerts;
CREATE POLICY "anon_update_recurring_alerts" ON recurring_issue_alerts FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_recurring_alerts" ON recurring_issue_alerts;
CREATE POLICY "anon_delete_recurring_alerts" ON recurring_issue_alerts FOR DELETE
  TO anon, authenticated USING (true);