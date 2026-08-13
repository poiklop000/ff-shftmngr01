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
--
-- Resetting the override (job_overrides row deleted) restores the setup
-- reason to the job's raw OFS order name (job_snapshots.order_name is never
-- overridden), so a "Reset to OFS" leaves every surface back on OFS values.

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
  IF TG_OP = 'DELETE' THEN
    SELECT min(s.order_name) INTO v_name
      FROM job_snapshots s
     WHERE s.job_id = OLD.job_id
       AND s.order_name IS NOT NULL;
  ELSE
    v_name := btrim(NEW.product_name);
  END IF;

  IF v_name IS NULL OR v_name = '' THEN
    RETURN NULL;
  END IF;

  SELECT min(floor(extract(epoch FROM capture_time) * 1000))::bigint
    INTO v_job_start
    FROM job_snapshots
   WHERE job_id = COALESCE(NEW.job_id, OLD.job_id);

  IF v_job_start IS NULL THEN
    RETURN NULL;
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

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_job_override_product_to_setup_reason ON job_overrides;
CREATE TRIGGER trg_job_override_product_to_setup_reason
  AFTER INSERT OR UPDATE OF product_name ON job_overrides
  FOR EACH ROW
  EXECUTE FUNCTION apply_job_override_product_to_setup_reason();

DROP TRIGGER IF EXISTS trg_job_override_product_to_setup_reason_del ON job_overrides;
CREATE TRIGGER trg_job_override_product_to_setup_reason_del
  AFTER DELETE ON job_overrides
  FOR EACH ROW
  EXECUTE FUNCTION apply_job_override_product_to_setup_reason();
