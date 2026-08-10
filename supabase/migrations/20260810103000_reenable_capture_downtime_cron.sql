/*
# Re-enable capture-downtime cron for running-slow events

## Context
The per-minute capture-downtime job was disabled in favour of the 5-minute
sync-spans-history cron. But sync-spans-history only extracts express
downtime spans + setup spans — it never records running-slow spans. As a
result, running-slow events stopped being captured (none since Aug 3) and no
longer appear on the board's shift timeline.

Running-slow events are short (typically 3-5 minutes), so a 5-minute sync
cannot reliably catch them. The per-minute capture-downtime job records them
as they appear in the live feed (state contains "slow").

## What changed
- Recreates `_capture_downtime_cron()` using the fixed `net.http_get`
  pattern (direct scalar assignment, matching `20260726104450`).
- Re-enables the `capture_downtime_job` to run every minute, creating the
  job if it is missing.

## Safety
- No table, data, or RLS changes. The job simply starts firing again.
*/

CREATE OR REPLACE FUNCTION public._capture_downtime_cron()
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
  SELECT value INTO fn_url FROM app_config WHERE key = 'capture_downtime_url';
  SELECT value INTO anon_key FROM app_config WHERE key = 'supabase_anon_key';

  IF fn_url IS NULL OR anon_key IS NULL THEN
    RAISE LOG 'capture_downtime: missing config in app_config table';
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

REVOKE EXECUTE ON FUNCTION public._capture_downtime_cron() FROM PUBLIC, anon, authenticated;

DO $$
DECLARE
  j record;
  found boolean := false;
BEGIN
  FOR j IN
    SELECT jobid FROM cron.job
    WHERE jobname = 'capture_downtime_job'
  LOOP
    PERFORM cron.alter_job(j.jobid, schedule := '* * * * *', active := true);
    found := true;
  END LOOP;
  IF NOT found THEN
    PERFORM cron.schedule(
      'capture_downtime_job',
      '* * * * *',
      $cron_cmd$ SELECT public._capture_downtime_cron(); $cron_cmd$
    );
  END IF;
END $$;
