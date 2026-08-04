/*
# Downtime alert enhancements: escalation, product context, production impact

## Purpose
Support the enhanced Teams downtime alerts:

- Long-downtime escalation: an ongoing event that has already fired its initial
  OCCURRED alert can fire further "still ongoing" alerts at escalating
  durations (default 30/60/120 minutes), tracked per event.
- Product context + production impact: alerts look up the active job snapshot
  captured before the event started (product / rated speed) to show the product
  and an estimated cans-lost figure.

## What changed
- `downtime_events.last_escalation_minutes` (int) — highest escalation level
  already alerted for an ongoing event.
- `app_config.teams_alert_escalation_minutes` = "30,60,120" (comma-separated
  minute thresholds).
- `app_config.teams_default_cans_per_hour` = "24000" (fallback rate when no job
  snapshot is available).
*/

alter table downtime_events
  add column if not exists last_escalation_minutes integer;

insert into app_config (key, value) values
  ('teams_alert_escalation_minutes', '30,60,120'),
  ('teams_default_cans_per_hour', '24000')
on conflict (key) do nothing;
