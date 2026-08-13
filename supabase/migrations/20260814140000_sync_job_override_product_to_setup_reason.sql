-- # Sync a corrected job product name into the SETUP event's reason
--
-- When the user corrects a job's product name (job_overrides.product_name),
-- the SETUP downtime event captured for that job still shows the raw OFS
-- product name. This trigger keeps the event's reason in sync with the
-- correction so boards/alerts show the corrected name.
--
-- Setup events do NOT carry a job_id (the live setup span has no job link), so
-- the job's run window is approximated from job_snapshots: the job's start is
-- its earliest capture_time. The setup for that job is the SETUP event that
-- started immediately before that moment (within an 8h window so a long
-- changeover is still matched). Jobs with no snapshots are skipped, so an
-- unrelated setup is never renamed. sync-spans-history and capture-downtime
-- both preserve an existing non-null reason on their live setup/slow upserts,
-- so the corrected name is not reverted by the next poll.

CREATE OR REPLACE FUNCTION apply_job_override_product_to_setup_reason()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_name text;
  v_job_start bigint;
  v_target_id bigint;
BEGIN
  v_name := btrim(NEW.product_name);
  IF v_name = '' THEN
    RETURN NEW;
  END IF;

  SELECT min(floor(extract(epoch FROM capture_time) * 1000))::bigint
    INTO v_job_start
    FROM job_snapshots
   WHERE job_id = NEW.job_id;

  IF v_job_start IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT d.id INTO v_target_id
    FROM downtime_events d
   WHERE d.downtime_type = 'SETUP'
     AND d.start_epoch <= v_job_start + 5 * 60 * 1000
     AND d.start_epoch >= v_job_start - 8 * 60 * 60 * 1000
   ORDER BY d.start_epoch DESC, d.id DESC
   LIMIT 1;

  IF v_target_id IS NOT NULL THEN
    UPDATE downtime_events
       SET reason = v_name,
           updated_at = now()
     WHERE id = v_target_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_job_override_product_to_setup_reason ON job_overrides;
CREATE TRIGGER trg_job_override_product_to_setup_reason
  AFTER INSERT OR UPDATE OF product_name ON job_overrides
  FOR EACH ROW
  EXECUTE FUNCTION apply_job_override_product_to_setup_reason();
