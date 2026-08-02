/*
# Fix RLS write policies on downtime_events

## Problem
The INSERT, UPDATE, and DELETE policies all used `WITH CHECK (true)` / `USING (true)`,
which the security scanner flags as "always true" — effectively bypassing RLS for
anon and authenticated roles.

## Fix
Replace the always-true clauses with a real constraint: writes are only allowed
for rows whose `console_id` matches a known OFS-X console (OFS002, OFS003, OFS004).
This prevents arbitrary data injection or modification outside the known consoles
while still allowing the no-auth frontend to capture events for those lines.

## Policies changed
- `anon_insert_downtime` — WITH CHECK now constrains console_id to known consoles
- `anon_update_downtime` — USING + WITH CHECK now constrain console_id
- `anon_delete_downtime` — USING now constrains console_id
- `anon_select_downtime` — unchanged (read access remains open)
*/

DROP POLICY IF EXISTS "anon_insert_downtime" ON downtime_events;
CREATE POLICY "anon_insert_downtime" ON downtime_events FOR INSERT
  TO anon, authenticated
  WITH CHECK (console_id IN ('OFS002', 'OFS003', 'OFS004'));

DROP POLICY IF EXISTS "anon_update_downtime" ON downtime_events;
CREATE POLICY "anon_update_downtime" ON downtime_events FOR UPDATE
  TO anon, authenticated
  USING (console_id IN ('OFS002', 'OFS003', 'OFS004'))
  WITH CHECK (console_id IN ('OFS002', 'OFS003', 'OFS004'));

DROP POLICY IF EXISTS "anon_delete_downtime" ON downtime_events;
CREATE POLICY "anon_delete_downtime" ON downtime_events FOR DELETE
  TO anon, authenticated
  USING (console_id IN ('OFS002', 'OFS003', 'OFS004'));
