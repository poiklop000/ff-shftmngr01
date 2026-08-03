/*
# Add report_snapshot to monitoring_records

1. Purpose
   Store a rendered snapshot of the print report (markdown text) alongside the
   structured board data. "Save Record" now saves the report itself, so saved
   records can be viewed as a formatted report in Analytics without being
   loaded back onto the monitoring board.

2. Change
   - monitoring_records.report_snapshot (text, default '') - markdown of the
     print report (header, shift/date, SKUs, performance rows, totals, notes).
*/

ALTER TABLE monitoring_records
  ADD COLUMN IF NOT EXISTS report_snapshot text DEFAULT '';
