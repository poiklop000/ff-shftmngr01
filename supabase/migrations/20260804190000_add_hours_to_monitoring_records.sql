/*
# Add hours to monitoring_records

1. Purpose
   Store the exact shift interval hours ("06:00 - 07:00", ...) that were
   active when the record was saved. The saved report is rendered from the
   stored board data plus these hours, so the Analytics report view matches
   the print report exactly — including Custom shifts whose hours are not
   derivable from the shift name alone.
*/

ALTER TABLE monitoring_records
  ADD COLUMN IF NOT EXISTS hours jsonb DEFAULT '[]'::jsonb;
