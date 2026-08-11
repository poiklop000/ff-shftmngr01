import { useRef } from 'react';
import {
  formatNumberField,
  parseNumber,
  type ShiftRow,
  type ToggleState,
} from '@/types';
import { useAutoSelect, useAutoGrow, useEnterToNext } from '@/lib/ui';

interface ShiftTableProps {
  hours: string[];
  rows: Record<number, ShiftRow>;
  rowCount: number;
  onRowChange: (index: number, field: keyof ShiftRow, value: string) => void;
  onToggle: (index: number, field: 'q' | 's') => void;
  hideQaFields?: boolean;
  rowHeight?: number | null;
}

export function ShiftTable({ hours, rows, rowCount, onRowChange, onToggle, hideQaFields = false, rowHeight = null }: ShiftTableProps) {
  return (
    <div className="table-wrapper">
      <table>
        <thead>
          <tr>
            <th style={{ width: 120 }}>TIME INTERVAL</th>
            <th style={{ width: 110 }}>RATED SPEED</th>
            <th style={{ width: 110 }}>ACTUAL OUTPUT</th>
            <th style={{ width: 80 }}>OEE %</th>
            {!hideQaFields && (
              <>
                <th style={{ width: 70 }}>QUALITY</th>
                <th style={{ width: 70 }}>SAFETY</th>
              </>
            )}
            <th style={{ width: 380 }}>DOWNTIME LOGS</th>
            {!hideQaFields && (
              <>
                <th style={{ width: 110 }}>FILLER YIELD</th>
                <th style={{ width: 110 }}>SCRAP</th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {rowCount === 0 ? (
            <tr>
              <td colSpan={hideQaFields ? 5 : 9} style={{ padding: '30px', color: 'var(--text-muted)', fontSize: '14px' }}>
                Configure your custom start time, end time, and interval above, then click &quot;Generate Table&quot;.
              </td>
            </tr>
          ) : (
            Array.from({ length: rowCount }).map((_, i) => (
              <Row
                key={i}
                index={i}
                rowCount={rowCount}
                hour={hours[i] ?? ''}
                row={rows[i]}
                hideQaFields={hideQaFields}
                rowHeight={rowHeight}
                onChange={(field, value) => onRowChange(i, field, value)}
                onToggle={(field) => onToggle(i, field)}
              />
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

interface RowProps {
  index: number;
  rowCount: number;
  hour: string;
  row: ShiftRow;
  hideQaFields?: boolean;
  rowHeight?: number | null;
  onChange: (field: keyof ShiftRow, value: string) => void;
  onToggle: (field: 'q' | 's') => void;
}

function Row({ index, rowCount, hour, row, hideQaFields = false, rowHeight = null, onChange, onToggle }: RowProps) {
  const spdRef = useRef<HTMLInputElement>(null);
  const outRef = useRef<HTMLInputElement>(null);
  const yldRef = useRef<HTMLInputElement>(null);
  const scrRef = useRef<HTMLInputElement>(null);
  const logRef = useRef<HTMLTextAreaElement>(null);

  const spdId = `spd-${index}`;
  const outId = `out-${index}`;
  const yldId = `yld-${index}`;
  const scrId = `scr-${index}`;
  const logId = `log-${index}`;

  useAutoSelect(spdRef);
  useAutoSelect(outRef);
  useAutoSelect(yldRef);
  useAutoSelect(scrRef);
  useAutoGrow(logRef, row.log);

  useEnterToNext(spdRef, outId);
  useEnterToNext(outRef, logId);
  if (!hideQaFields) {
    useEnterToNext(yldRef, scrId);
    useEnterToNext(
      scrRef,
      index < rowCount - 1 ? `spd-${index + 1}` : 'tx-product'
    );
  }

  const rowOut = parseNumber(row.out);
  const rowSpd = parseNumber(row.spd);
  const oee = rowOut > 0 && rowSpd > 0 ? (rowOut / rowSpd) * 100 : 0;
  const oeeClass =
    rowOut > 0 && rowSpd > 0
      ? oee >= 70 ? 'oee-pass' : 'oee-fail'
      : 'oee-neutral';

  const yieldVal = row.yld.replace(/%/g, '').trim();
  const yieldNum = parseFloat(yieldVal) || 0;
  const yieldClass =
    yieldVal === '' ? '' : yieldNum < 97.0 ? 'yield-input-red' : 'yield-input-green';

  const scrapVal = row.scr.replace(/%/g, '').trim();
  const scrapClass = scrapVal === '' ? '' : '';

  const compactLog = hideQaFields
    ? row.log
        .split('\n')
        .map((line) => {
          const trimmed = line.trim();
          return trimmed.startsWith('*(')
            ? trimmed.slice(2, trimmed.endsWith(')') ? -1 : undefined).trim()
            : trimmed;
        })
        .filter(Boolean)
        .join(' · ')
    : row.log;

  return (
    <tr style={rowHeight ? { height: rowHeight } : undefined}>
      <td style={{ fontWeight: 700, whiteSpace: 'nowrap', color: 'var(--app-fg)' }}>
        {hour}
      </td>
      <td>
        <input
          ref={spdRef}
          id={spdId}
          type="text"
          className="table-input"
          inputMode="numeric"
          value={row.spd}
          placeholder="0"
          onChange={(e) => onChange('spd', e.target.value)}
          onBlur={(e) => onChange('spd', formatNumberField(e.target.value))}
        />
      </td>
      <td>
        <input
          ref={outRef}
          id={outId}
          type="text"
          className="table-input"
          inputMode="numeric"
          value={row.out}
          placeholder="0"
          onChange={(e) => onChange('out', e.target.value)}
          onBlur={(e) => onChange('out', formatNumberField(e.target.value))}
        />
      </td>
      <td>
        <span className={`oee-badge ${oeeClass}`}>
          {rowOut > 0 && rowSpd > 0 ? `${oee.toFixed(2)}%` : '0.00%'}
        </span>
      </td>
      {!hideQaFields && (
        <>
          <td>
            <ToggleBtn state={row.q} onClick={() => onToggle('q')} title="Q" />
          </td>
          <td>
            <ToggleBtn state={row.s} onClick={() => onToggle('s')} title="S" />
          </td>
        </>
      )}
      <td>
        {hideQaFields ? (
          <div className="board-log-compact" title={row.log}>
            {compactLog || '—'}
          </div>
        ) : (
          <>
            <textarea
              ref={logRef}
              id={logId}
              className="table-text-area no-print"
              value={row.log}
              onChange={(e) => onChange('log', e.target.value)}
              placeholder="Type shift delays... (Enter for new line, Tab for next field)"
            />
            <div className="print-text-block print-only">{row.log}</div>
          </>
        )}
      </td>
      {!hideQaFields && (
        <>
          <td>
            <input
              ref={yldRef}
              id={yldId}
              type="text"
              className={`table-input ${yieldClass}`}
              inputMode="decimal"
              value={row.yld}
              placeholder="0.0%"
              onChange={(e) => onChange('yld', e.target.value)}
              onBlur={(e) => {
                const clean = e.target.value.replace(/%/g, '').trim();
                const formatted = clean ? `${clean}%` : '';
                onChange('yld', formatted);
              }}
            />
          </td>
          <td>
            <input
              ref={scrRef}
              id={scrId}
              type="text"
              className={`table-input ${scrapClass}`}
              inputMode="decimal"
              value={row.scr}
              placeholder="0.0%"
              onChange={(e) => onChange('scr', e.target.value)}
              onBlur={(e) => {
                const clean = e.target.value.replace(/%/g, '').trim();
                const formatted = clean ? `${clean}%` : '';
                onChange('scr', formatted);
              }}
            />
          </td>
        </>
      )}
    </tr>
  );
}

function ToggleBtn({ state, onClick, title }: { state: ToggleState; onClick: () => void; title: string }) {
  const cls = state === 1 ? 'pass' : state === 2 ? 'issue' : 'neutral';
  const icon = state === 1 ? '✔' : state === 2 ? '✖' : '?';
  const label = state === 1 ? 'Pass' : state === 2 ? 'Issue Logged' : 'Not Selected';
  return (
    <button
      type="button"
      className={`toggle-btn ${cls}`}
      onClick={onClick}
      title={`${title}: ${label}`}
    >
      {icon}
    </button>
  );
}
