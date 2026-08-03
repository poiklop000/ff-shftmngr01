import { useMemo } from 'react';
import { Package } from 'lucide-react';
import {
  parseNumber,
  SHIFT_LABELS,
  type Shift,
  type ShiftData,
  type ToggleState,
} from '@/types';
import { DowntimeTimeline } from '@/components/DowntimeTimeline';
import type { DowntimeEvent } from '@/lib/downtime';

interface ShiftReportProps {
  shift: Shift;
  date: string;
  hours: string[];
  boardData: ShiftData;
  notes: string;
  sku: string;
  downtimeEvents?: DowntimeEvent[];
}

function toggleLabel(state: ToggleState): string {
  return state === 1 ? '✔' : state === 2 ? '✖' : '?';
}

function toggleClass(state: ToggleState): string {
  return state === 1 ? 'pass' : state === 2 ? 'issue' : 'neutral';
}

/**
 * Renders the shift board exactly as it appears in the printed report. Used by
 * the Analytics saved-record report modal so a saved report looks identical to
 * the print report.
 */
export function ShiftReport({ shift, date, hours, boardData, notes, sku, downtimeEvents }: ShiftReportProps) {
  const rows = boardData.rows;
  const rowCount = Object.keys(rows).length;

  const { totalOutput, avgOee } = useMemo(() => {
    let total = 0;
    let oeeSum = 0;
    let count = 0;
    for (let i = 0; i < rowCount; i++) {
      const r = rows[i];
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
  }, [rows, rowCount]);

  const skuLines = (sku || '').split('\n').filter(Boolean);

  return (
    <div className="shift-report">
      <div className="card card-blue">
        <h3 style={{ margin: 0, border: 'none', padding: 0, borderBottom: '1px solid currentColor', paddingBottom: 6 }}>
          Free-Flow Performance Board — {SHIFT_LABELS[shift]} · {date || 'No date selected'}
        </h3>
        <div className="card-row sku-card" style={{ marginTop: 12, flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
          <label style={{ fontSize: 11, fontWeight: 700, color: '#1e3a8a', textTransform: 'uppercase', letterSpacing: '0.3px', display: 'flex', alignItems: 'center', gap: 4 }}>
            <Package size={13} />
            SKUs:
          </label>
          {skuLines.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {skuLines.map((job, i) => {
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

      {downtimeEvents && (
        <DowntimeTimeline
          events={downtimeEvents}
          currentShift={shift}
          customHours={hours}
          date={date}
          consoleTime="-"
          loading={false}
        />
      )}

      <div className="table-wrapper report-table-scroll">
        <table className="report-table">
          <thead>
            <tr>
              <th>Time Interval</th>
              <th>Rated Speed</th>
              <th>Actual Output</th>
              <th>OEE %</th>
              <th>Quality</th>
              <th>Safety</th>
              <th>Downtime Logs</th>
              <th>Filler Yield</th>
              <th>Scrap</th>
            </tr>
          </thead>
          <tbody>
            {rowCount === 0 ? (
              <tr>
                <td colSpan={9} style={{ padding: '30px', color: '#64748b', fontSize: '14px' }}>
                  No monitoring rows saved for this shift.
                </td>
              </tr>
            ) : (
              Array.from({ length: rowCount }).map((_, i) => {
                const r = rows[i];
                if (!r) return null;
                const out = parseNumber(r.out);
                const spd = parseNumber(r.spd);
                const oee = out > 0 && spd > 0 ? (out / spd) * 100 : 0;
                return (
                  <tr key={i}>
                    <td style={{ fontWeight: 700, fontSize: 13, whiteSpace: 'nowrap', color: '#334155' }}>
                      {hours[i] ?? '-'}
                    </td>
                    <td>{r.spd || '0'}</td>
                    <td>{r.out || '0'}</td>
                    <td>{out > 0 && spd > 0 ? `${oee.toFixed(2)}%` : '0.00%'}</td>
                    <td><span className={`report-toggle ${toggleClass(r.q)}`}>{toggleLabel(r.q)}</span></td>
                    <td><span className={`report-toggle ${toggleClass(r.s)}`}>{toggleLabel(r.s)}</span></td>
                    <td style={{ textAlign: 'left', whiteSpace: 'pre-wrap' }}>{r.log || '-'}</td>
                    <td>{r.yld || '-'}</td>
                    <td>{r.scr || '-'}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="card card-blue">
        <h3>Notes</h3>
        <div className="print-text-block">{notes || '-'}</div>
      </div>
    </div>
  );
}
