import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, Loader2, Save, FolderOpen, CheckCircle2, Package, FileDown, Printer } from 'lucide-react';
import {
  filterByShiftWindow,
  getActiveHours,
  parseNumber,
  SHIFT_LABELS,
  type Shift,
  type ShiftDb,
  type ShiftRow,
} from '@/types';
import { ShiftTable } from '@/components/ShiftTable';
import { DowntimeTimeline } from '@/components/DowntimeTimeline';
import { PageHelp } from '@/components/PageHelp';
import { fetchDowntimeByDate, type DowntimeEvent } from '@/lib/downtime';
import { fetchOfsStatus, type OfsLiveStatus } from '@/lib/ofs';
import { fetchJobsForShift } from '@/lib/jobSnapshots';
import { useAutoGrow } from '@/lib/ui';

function csvEscape(value: string | number): string {
  const str = String(value ?? '');
  return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

interface MonitoringViewProps {
  db: ShiftDb;
  notes: Record<Shift, string>;
  sku: Record<Shift, string>;
  currentShift: Shift;
  customHours: string[];
  date: string;
  onRowChange: (shift: Shift, index: number, field: keyof ShiftRow, value: string) => void;
  onToggle: (shift: Shift, index: number, field: 'q' | 's') => void;
  onMetaChange: (shift: Shift, field: 'date' | 'sku' | 'notes', value: string) => void;
  onClearShift: (shift: Shift) => void;
  onExportReport: () => void;
  onImportCounter: () => Promise<void>;
  onImportDowntime: () => Promise<void>;
  onSaveRecord: () => Promise<void>;
  onLoadRecord: () => Promise<void>;
  hasSavedRecord: boolean;
}

export function MonitoringView({
  db,
  notes,
  sku,
  currentShift,
  customHours,
  date,
  onRowChange,
  onToggle,
  onMetaChange,
  onClearShift,
  onExportReport,
  onImportCounter,
  onImportDowntime,
  onSaveRecord,
  onLoadRecord,
  hasSavedRecord,
}: MonitoringViewProps) {
  const [importingCounter, setImportingCounter] = useState(false);
  const [importingDowntime, setImportingDowntime] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadingRecord, setLoadingRecord] = useState(false);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [timelineEvents, setTimelineEvents] = useState<DowntimeEvent[]>([]);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [consoleTime, setConsoleTime] = useState('-');
  const [activeJobs, setActiveJobs] = useState<string[]>([]);
  const [jobsLoading, setJobsLoading] = useState(false);
  const [jobsError, setJobsError] = useState<string | null>(null);

  const activeHours = getActiveHours(currentShift, customHours);

  const loadTimeline = useCallback(async (shift: Shift, customHrs: string[], shiftDate: string) => {
    if (!shiftDate) { setTimelineEvents([]); return; }
    setTimelineLoading(true);
    try {
      const hours = getActiveHours(shift, customHrs);
      const startStr = hours[0]?.split(' - ')[0]?.trim();
      const isOvernight = startStr ? parseInt(startStr.split(':')[0] ?? '0', 10) >= 12 : false;
      const events = await fetchDowntimeByDate(shiftDate);
      if (isOvernight) {
        const d = new Date(`${shiftDate}T00:00:00`);
        d.setDate(d.getDate() + 1);
        const ny = d.getFullYear();
        const nm = String(d.getMonth() + 1).padStart(2, '0');
        const nd = String(d.getDate()).padStart(2, '0');
        const next = await fetchDowntimeByDate(`${ny}-${nm}-${nd}`);
        events.push(...next);
        events.sort((a, b) => b.start_epoch - a.start_epoch);
      }
      setTimelineEvents(events);
    } catch {
      setTimelineEvents([]);
    } finally {
      setTimelineLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTimeline(currentShift, customHours, date);
  }, [loadTimeline, currentShift, customHours, date]);

  // Auto-populate SKU from job snapshots in the database
  useEffect(() => {
    if (!date) return;
    let cancelled = false;
    setJobsLoading(true);
    setJobsError(null);
    fetchJobsForShift(date, currentShift, customHours)
      .then((jobs) => {
        if (cancelled) return;
        setActiveJobs(jobs);
        if (jobs.length > 0 && sku[currentShift] !== jobs.join('\n')) {
          onMetaChange(currentShift, 'sku', jobs.join('\n'));
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setJobsError(err instanceof Error ? err.message : 'Failed to load jobs');
      })
      .finally(() => { if (!cancelled) setJobsLoading(false); });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, currentShift, customHours]);

  useEffect(() => {
    let cancelled = false;
    const loadConsoleTime = async () => {
      try {
        const data: OfsLiveStatus = await fetchOfsStatus();
        if (cancelled) return;
        const t = data.workcentre?.consoletimeText || data.timestampText || '-';
        setConsoleTime(t);
      } catch {
        // leave existing console time if the fetch fails
      }
    };
    loadConsoleTime();
    const id = setInterval(loadConsoleTime, 15000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const shiftTimelineEvents = useMemo(
    () => filterByShiftWindow(timelineEvents, currentShift, activeHours, date, (e) => e.start_text),
    [timelineEvents, currentShift, activeHours, date],
  );

  const handleSave = async () => {
    setSaving(true);
    setImportMsg(null);
    try {
      await onSaveRecord();
      setImportMsg('Record saved to database');
    } catch (err) {
      setImportMsg(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const handleLoadRecord = async () => {
    setLoadingRecord(true);
    setImportMsg(null);
    try {
      await onLoadRecord();
      setImportMsg('Record loaded from database');
    } catch (err) {
      setImportMsg(err instanceof Error ? err.message : 'Load failed');
    } finally {
      setLoadingRecord(false);
    }
  };

  const handleImportCounter = async () => {
    setImportingCounter(true);
    setImportMsg(null);
    try {
      await onImportCounter();
      setImportMsg('Counter data imported');
    } catch (err) {
      setImportMsg(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setImportingCounter(false);
    }
  };

  const handleImportDowntime = async () => {
    setImportingDowntime(true);
    setImportMsg(null);
    try {
      await onImportDowntime();
      setImportMsg('Downtime logs imported');
    } catch (err) {
      setImportMsg(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setImportingDowntime(false);
    }
  };

  const handleExportCsv = () => {
    const hours = activeHours;
    const rows = currentData.rows;
    const count = Object.keys(rows).length;
    const lines: string[] = [];

    lines.push(`Shift,${csvEscape(SHIFT_LABELS[currentShift])}`);
    lines.push(`Date,${csvEscape(date || '')}`);
    lines.push('');

    lines.push([
      'Time Interval', 'Rated Speed', 'Actual Output', 'OEE %',
      'Quality', 'Safety', 'Downtime Logs', 'Filler Yield', 'Scrap',
    ].map(csvEscape).join(','));

    let totalOut = 0;
    for (let i = 0; i < count; i++) {
      const r = rows[i];
      if (!r) continue;
      const rowOut = parseNumber(r.out);
      const rowSpd = parseNumber(r.spd);
      const oee = rowOut > 0 && rowSpd > 0 ? ((rowOut / rowSpd) * 100).toFixed(2) : '0.00';
      totalOut += rowOut;
      lines.push([
        hours[i] ?? '',
        r.spd,
        r.out,
        `${oee}%`,
        r.q === 1 ? 'Pass' : r.q === 2 ? 'Issue Logged' : '',
        r.s === 1 ? 'Pass' : r.s === 2 ? 'Issue Logged' : '',
        r.log,
        r.yld,
        r.scr,
      ].map(csvEscape).join(','));
    }

    lines.push(['Total', '', totalOut.toLocaleString(), '', '', '', '', '', ''].map(csvEscape).join(','));
    lines.push('');
    lines.push(`Notes,${csvEscape(notes[currentShift] || '')}`);

    const csv = '\uFEFF' + lines.join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const safeShift = currentShift.replace(/[^A-Za-z0-9]+/g, '');
    a.href = url;
    a.download = `FF_${safeShift}${date ? `_${date}` : ''}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setImportMsg('CSV exported');
  };

  const currentData = db[currentShift];
  const rowCount = Object.keys(currentData.rows).length;

  const { totalOutput, avgOee } = useMemo(() => {
    let total = 0;
    let oeeSum = 0;
    let count = 0;
    for (let i = 0; i < rowCount; i++) {
      const r = currentData.rows[i];
      if (!r) continue;
      total += parseNumber(r.out);
      const rowOut = parseNumber(r.out);
      const rowSpd = parseNumber(r.spd);
      if (rowOut > 0 && rowSpd > 0) {
        oeeSum += (rowOut / rowSpd) * 100;
        count++;
      }
    }
    return {
      totalOutput: total.toLocaleString(),
      avgOee: count > 0 ? (oeeSum / count).toFixed(2) : '0.00',
    };
  }, [currentData, rowCount]);

  const notesRef = useRef<HTMLTextAreaElement>(null);
  useAutoGrow(notesRef, notes[currentShift], 80);

  return (
    <div>
      <PageHelp
        title="Monitoring"
        intro="This is your shift handover board. Track rated speed, actual output, OEE, quality, safety, downtime, yield, and scrap for each time interval of the selected shift."
        sections={[
          {
            title: "Setting up the shift",
            items: [
              "Pick a shift from the dropdown at the top of the page: Morning, Night, 1st, 2nd, 3rd, or Custom.",
              "Set the date. A date is needed for auto-filling the SKUs, importing data, the timeline, and saving or loading records.",
              "For Custom, set your own start time, end time, and interval (15, 30, 60, or 120 minutes) in the header bar, then click Generate Table to build the rows.",
            ],
          },
          {
            title: "Filling in the table",
            items: [
              "Each row is one time interval. Type in Rated Speed and Actual Output for each row.",
              "OEE % is auto-calculated from output vs rated speed. Green at 70% or above, red below.",
              "Quality and Safety columns are toggle buttons. Click to cycle through Not Set, Pass, and Issue Logged.",
              "Downtime Logs - type any delays or notes for that interval. Press Enter for a new line, Tab to move to the next field.",
              "Filler Yield - enter the yield percentage. It turns red below 97% and green at 97% or above.",
              "Scrap - enter the scrap percentage for that interval.",
            ],
          },
          {
            title: "Active jobs (SKUs)",
            items: [
              "The products for the shift's active jobs auto-populate at the top of the board from the job snapshots captured in the database.",
              "Each active job shows a badge (Job 1, Job 2, ...) followed by the product name.",
              "If no jobs are listed, no snapshots were captured for that date and shift, or the line was not running.",
            ],
          },
          {
            title: "Importing data automatically",
            items: [
              "Import Counter - fills the Actual Output column with the hourly production counts for the selected date and shift.",
              "Import Downtime - pulls downtime events from the database and maps them into the Downtime Logs column for the correct time intervals.",
              "Both imports require a date to be selected first. Overnight shifts automatically include the next day's data across midnight.",
            ],
          },
          {
            title: "Notes and exporting",
            items: [
              "Notes - type handover notes or observations. They are included in saved records, the print report, and the CSV export.",
              "Print Report - prints the full shift report as a PDF (the help guide and input fields are excluded).",
              "Export CSV - downloads the shift data as a CSV file (shift, date, per-interval rows, totals, and notes) you can open in Excel.",
              "Clear Shift Data - wipes all entered data for the current shift. You'll be asked to confirm first.",
            ],
          },
          {
            title: "Saving and loading records",
            items: [
              "Save Record - stores everything on the board (rows, notes, SKU) plus the active job, downtime events, and counter readings for the selected date and shift in the database.",
              "Load Record - restores a previously saved record for the selected date and shift. It is disabled when no record exists.",
              "Saving again for the same date and shift replaces the previous record.",
            ],
          },
          {
            title: "Timeline bar",
            items: [
              "The bar above the table shows downtime events across the shift in colour: red for unplanned, blue for planned, yellow for setup.",
              "A dark vertical line shows the current time within the shift (the 'now' marker).",
              "The green portion shows how far through the shift you are.",
            ],
          },
        ]}
      />

      <div className="card card-blue">
        <h3 style={{ margin: 0, border: 'none', padding: 0, borderBottom: '1px solid currentColor', paddingBottom: 6 }}>
          Free-Flow Performance Board — {SHIFT_LABELS[currentShift]} · {date || 'No date selected'}
        </h3>

        <div className="card-row sku-card" style={{ marginTop: 12, flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
          <label style={{ fontSize: 11, fontWeight: 700, color: '#1e3a8a', textTransform: 'uppercase', letterSpacing: '0.3px', display: 'flex', alignItems: 'center', gap: 4 }}>
            <Package size={13} />
            SKUs:
          </label>
          {jobsLoading ? (
            <span style={{ fontSize: 12, color: '#64748b', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
              <Loader2 size={12} className="animate-spin" /> Loading active jobs from database…
            </span>
          ) : jobsError ? (
            <span style={{ fontSize: 12, color: '#b91c1c', fontWeight: 600 }}>{jobsError}</span>
          ) : activeJobs.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {activeJobs.map((job, i) => {
                const [jobName, ...rest] = job.split('\n');
                const product = rest.join(' ');
                return (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 10, fontWeight: 700, color: '#1d4ed8', backgroundColor: '#dbeafe', border: '1px solid #bfdbfe', borderRadius: 999, padding: '2px 10px', whiteSpace: 'nowrap' }}>
                      {jobName}
                    </span>
                    <span style={{ fontSize: 13, fontWeight: 600, color: '#1e3a8a', lineHeight: 1.4 }}>
                      {product}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : (
            <span style={{ fontSize: 12, color: '#64748b', fontWeight: 500 }}>
              No active jobs captured for this shift yet.
            </span>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'center', gap: 12, marginBottom: 15, alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          type="button"
          className="tab-btn tab-btn-red"
          onClick={() => {
            if (confirm('WARNING: You are about to completely delete all data entered for this shift. Do you want to proceed?')) {
              onClearShift(currentShift);
            }
          }}
        >
          Clear Shift Data
        </button>
      </div>

      <div style={{ display: 'flex', gap: 15, marginBottom: 15, justifyContent: 'center', flexWrap: 'wrap' }}>
        <div className="card card-green">
          <div className="card-row">
            <span>Shift Total Output:</span>
            <span style={{ fontWeight: 'bold', fontSize: 14, color: '#166534' }}>{totalOutput}</span>
          </div>
        </div>
        <div className="card card-teal">
          <div className="card-row">
            <span>Shift Average OEE:</span>
            <span style={{ fontWeight: 'bold', fontSize: 14, color: '#115e59' }}>{avgOee}%</span>
          </div>
        </div>
      </div>

      <DowntimeTimeline
        events={shiftTimelineEvents}
        currentShift={currentShift}
        customHours={customHours}
        date={date}
        consoleTime={consoleTime}
        loading={timelineLoading}
      />

      <ShiftTable
        hours={activeHours}
        rows={currentData.rows}
        rowCount={rowCount}
        onRowChange={(index, field, value) => onRowChange(currentShift, index, field, value)}
        onToggle={(index, field) => onToggle(currentShift, index, field)}
      />

      <div className="card card-blue">
        <h3>Notes</h3>
        <textarea
          ref={notesRef}
          className="table-text-area no-print"
          rows={1}
          style={{ width: '100%', maxWidth: '100%', minHeight: 80, fontSize: 13, fontWeight: 500, color: '#0f172a', textAlign: 'left' }}
          placeholder="Enter production run details, observations, or handover notes... (Enter for new line)"
          value={notes[currentShift]}
          onChange={(e) => onMetaChange(currentShift, 'notes', e.target.value)}
        />
        <div className="print-text-block print-only">{notes[currentShift]}</div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'center', gap: 12, marginTop: 18, alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          type="button"
          className="tab-btn tab-btn-green"
          onClick={handleImportCounter}
          disabled={importingCounter || importingDowntime}
          title="Pull hourly production counts from OFS for the selected date and fill the Actual Output column"
        >
          {importingCounter ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
          Import Counter
        </button>
        <button
          type="button"
          className="tab-btn tab-btn-amber"
          onClick={handleImportDowntime}
          disabled={importingCounter || importingDowntime}
          title="Pull downtime events from the database for the selected date and fill the Downtime Logs column"
        >
          {importingDowntime ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
          Import Downtime
        </button>
        <button type="button" className="tab-btn tab-btn-blue" onClick={onExportReport}>
          <Printer size={14} /> Print Report
        </button>
        <button type="button" className="tab-btn tab-btn-blue" onClick={handleExportCsv}>
          <FileDown size={14} /> Export CSV
        </button>
      </div>
      <div style={{ display: 'flex', justifyContent: 'center', gap: 12, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          type="button"
          className="tab-btn tab-btn-green"
          onClick={handleSave}
          disabled={saving || loadingRecord || importingCounter || importingDowntime}
          title="Save the current board data, active job, downtime, and counter readings to the database"
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          Save Record
        </button>
        <button
          type="button"
          className="tab-btn tab-btn-amber"
          onClick={handleLoadRecord}
          disabled={saving || loadingRecord || importingCounter || importingDowntime || !hasSavedRecord}
          title={hasSavedRecord ? 'Load a previously saved record for this date and shift' : 'No saved record for this date and shift'}
        >
          {loadingRecord ? <Loader2 size={14} className="animate-spin" /> : <FolderOpen size={14} />}
          Load Record
        </button>
        {hasSavedRecord && !saving && !loadingRecord && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 600, color: '#166534' }}>
            <CheckCircle2 size={12} /> Saved record exists
          </span>
        )}
      </div>
      {importMsg && (
        <div style={{ textAlign: 'center', marginTop: 8, fontSize: 12, fontWeight: 600, color: importMsg.includes('failed') ? '#b91c1c' : '#166534' }}>
          {importMsg}
        </div>
      )}
    </div>
  );
}
