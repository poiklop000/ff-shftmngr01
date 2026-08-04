import { useCallback, useEffect, useState } from 'react';
import { FileDown, Loader2, ExternalLink, Printer, History, X } from 'lucide-react';
import { PageHelp } from '@/components/PageHelp';
import { ShiftReport } from '@/components/ShiftReport';
import { getActiveHours, type Shift } from '@/types';
import {
  fetchMonitoringRecordsInRange,
} from '@/lib/analytics';
import { fetchRecordAudit, type MonitoringRecord, type MonitoringRecordAudit } from '@/lib/monitoring';
import { downloadCsv } from '@/lib/export';

export function SavedRecordsView() {
  const [records, setRecords] = useState<MonitoringRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [shiftFilter, setShiftFilter] = useState('All');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [reportRecord, setReportRecord] = useState<MonitoringRecord | null>(null);
  const [printRecord, setPrintRecord] = useState<MonitoringRecord | null>(null);
  const [auditRecord, setAuditRecord] = useState<MonitoringRecord | null>(null);
  const [auditEntries, setAuditEntries] = useState<MonitoringRecordAudit[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      let start = dateFrom || '2020-01-01';
      let end = dateTo || new Date().toISOString().split('T')[0];
      if (start > end) [start, end] = [end, start];
      const data = await fetchMonitoringRecordsInRange(start, end);
      setRecords(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load saved records');
    } finally {
      setLoading(false);
    }
  }, [dateFrom, dateTo]);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = records.filter((r) => {
    const q = search.trim().toLowerCase();
    if (q) {
      const hay = `${r.record_date} ${r.shift_name} ${r.sku ?? ''} ${r.saved_by ?? ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (shiftFilter !== 'All' && r.shift_name !== shiftFilter) return false;
    return true;
  });

  const shifts = Array.from(new Set(records.map((r) => r.shift_name))).sort();

  const handleOpenHistory = useCallback(async (r: MonitoringRecord) => {
    setAuditRecord(r);
    setAuditEntries([]);
    setAuditLoading(true);
    try {
      setAuditEntries(await fetchRecordAudit(r.id));
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Failed to load record history');
    } finally {
      setAuditLoading(false);
    }
  }, []);

  const handleExportCsv = () => {
    downloadCsv(
      `saved_records_${dateFrom || 'all'}_to_${dateTo || 'all'}.csv`,
      ['Date', 'Shift', 'SKU', 'Saved By', 'Saved At'],
      filtered.map((r) => [r.record_date, r.shift_name, r.sku ?? '-', r.saved_by ?? '-', r.created_at]),
    );
    setMsg('Records CSV exported');
  };

  const handlePrintReport = (r: MonitoringRecord) => {
    setPrintRecord(r);
    document.body.classList.add('printing-saved-report');
    const original = document.title;
    const reportName = `FF_${r.shift_name}${r.record_date ? `_${r.record_date}` : ''}`;
    document.title = reportName;
    const restore = () => {
      document.title = original;
      document.body.classList.remove('printing-saved-report');
      setPrintRecord(null);
      window.removeEventListener('afterprint', restore);
    };
    window.addEventListener('afterprint', restore);
    window.setTimeout(restore, 60_000);
    window.setTimeout(() => window.print(), 150);
  };

  return (
    <div>
      <PageHelp
        title="Saved Monitoring Records"
        intro="Browse and review all saved monitoring records with search, filters, and CSV export."
        sections={[
          {
            title: "Browse saved records",
            items: [
              "All saved monitoring records are listed with date, shift, SKU, and who saved them.",
              "Use the search box to filter by date, shift, SKU, or saved-by name.",
              "Use the shift filter to show only a specific shift.",
            ],
          },
          {
            title: "Actions",
            items: [
              "View — opens a read-only on-screen preview of the record (does not affect the Monitoring board).",
              "Report — opens the browser print dialog so you can save the report as a PDF, identical to the Monitoring page's Print Report.",
              "History — shows the audit trail of who saved/edited the record and when.",
            ],
          },
          {
            title: "Export",
            items: [
              "CSV button exports the filtered list to a spreadsheet.",
            ],
          },
        ]}
      />
      <div className="card card-teal saved-records-list">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginBottom: 10 }}>
          <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 18 }}>📁</span>
            Saved Monitoring Records
          </h3>
          <button type="button" className="tab-btn tab-btn-blue" style={{ padding: '6px 12px', fontSize: 12 }} onClick={handleExportCsv}>
            <FileDown size={14} /> Export CSV
          </button>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12, alignItems: 'center' }}>
          <input
            type="search"
            placeholder="Search date, shift, SKU, saved by…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ flex: 1, minWidth: 200, fontSize: 13, padding: '6px 10px', borderRadius: 6, border: '1px solid var(--input-border)', backgroundColor: 'var(--input-bg)', color: 'var(--input-text)' }}
          />
          <select
            value={shiftFilter}
            onChange={(e) => setShiftFilter(e.target.value)}
            style={{ fontSize: 13, padding: '6px 10px', borderRadius: 6, border: '1px solid var(--input-border)', backgroundColor: 'var(--input-bg)', color: 'var(--input-text)', minWidth: 140 }}
          >
            <option value="All">All Shifts</option>
            {shifts.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            placeholder="From"
            style={{ fontSize: 13, padding: '6px 10px', borderRadius: 6, border: '1px solid var(--input-border)', backgroundColor: 'var(--input-bg)', color: 'var(--input-text)', width: 160 }}
          />
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            placeholder="To"
            style={{ fontSize: 13, padding: '6px 10px', borderRadius: 6, border: '1px solid var(--input-border)', backgroundColor: 'var(--input-bg)', color: 'var(--input-text)', width: 160 }}
          />
          {(search || shiftFilter !== 'All' || dateFrom || dateTo) && (
            <button type="button" className="tab-btn" style={{ padding: '6px 10px', fontSize: 12 }} onClick={() => { setSearch(''); setShiftFilter('All'); setDateFrom(''); setDateTo(''); }}>
              <X size={14} /> Clear
            </button>
          )}
        </div>

        {error && (
          <div style={{ fontSize: 12, color: 'var(--danger-text)', background: 'var(--danger-bg)', border: '1px solid var(--danger-border)', borderRadius: 8, padding: '8px 10px', fontWeight: 600, marginBottom: 10 }}>
            {error}
          </div>
        )}

        {loading && records.length === 0 ? (
          <div className="card-scroll" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, fontSize: 13, color: 'var(--text-muted)', fontWeight: 600 }}>
            <Loader2 size={18} className="animate-spin" style={{ marginRight: 8 }} />
            Loading saved records…
          </div>
        ) : filtered.length === 0 ? (
          <div className="card-scroll" style={{ padding: 24, fontSize: 13, color: 'var(--text-muted)', fontWeight: 500, textAlign: 'center' }}>
            {records.length === 0 ? 'No saved monitoring records found.' : 'No records match the current filters.'}
          </div>
        ) : (
          <div className="card-scroll" style={{ maxHeight: 520 }}>
            <table className="w-full text-[13px]" style={{ minWidth: 560 }}>
              <thead>
                <tr className="text-left text-[11px] font-bold uppercase tracking-wide text-slate-800 border-b border-slate-200">
                  <th className="px-4 py-2.5">Date</th>
                  <th className="px-4 py-2.5">Shift</th>
                  <th className="px-4 py-2.5">SKU</th>
                  <th className="px-4 py-2.5">Saved By</th>
                  <th className="px-4 py-2.5">Saved At</th>
                  <th className="px-4 py-2.5"></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <tr key={r.id} className="border-b border-slate-100 hover:bg-slate-50 transition-colors">
                    <td className="px-4 py-3 text-slate-700 whitespace-nowrap">{r.record_date}</td>
                    <td className="px-4 py-3 text-slate-600 whitespace-nowrap">{r.shift_name}</td>
                    <td className="px-4 py-3 text-slate-700 font-medium">{r.sku ?? '-'}</td>
                    <td className="px-4 py-3 text-slate-600">{r.saved_by ?? '-'}</td>
                    <td className="px-4 py-3 text-slate-500 text-[12px]">{r.created_at ? new Date(r.created_at).toLocaleString() : '-'}</td>
                    <td className="px-4 py-3" style={{ whiteSpace: 'nowrap', display: 'flex', gap: 6 }}>
                      <button type="button" className="tab-btn tab-btn-green" style={{ padding: '4px 10px', fontSize: 11 }} onClick={() => setReportRecord(r)} title="Preview the record on screen">
                        <ExternalLink size={12} /> View
                      </button>
                      <button type="button" className="tab-btn tab-btn-blue" style={{ padding: '4px 10px', fontSize: 11 }} onClick={() => handlePrintReport(r)} title="Print the report as a PDF (same as Monitoring Print Report)">
                        <Printer size={12} /> Report
                      </button>
                      <button type="button" className="tab-btn tab-btn-purple" style={{ padding: '4px 10px', fontSize: 11 }} onClick={() => handleOpenHistory(r)} title="View audit history">
                        <History size={12} /> History
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {msg && (
          <div style={{ textAlign: 'center', marginTop: 10, fontSize: 12, fontWeight: 600, color: 'var(--success-text)' }}>
            {msg}
          </div>
        )}
      </div>

      {reportRecord && (
        <div className="modal-overlay" onClick={() => setReportRecord(null)}>
          <div className="modal-card report-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Saved Record — {reportRecord.shift_name} · {reportRecord.record_date} · {reportRecord.sku ?? 'No SKU'}</h2>
              <button type="button" className="modal-close-btn" onClick={() => setReportRecord(null)} aria-label="Close">✕</button>
            </div>
            <ShiftReport
              shift={reportRecord.shift_name as Shift}
              date={reportRecord.record_date}
              hours={reportRecord.hours?.length ? reportRecord.hours : getActiveHours(reportRecord.shift_name as Shift, [])}
              boardData={reportRecord.board_data}
              notes={reportRecord.notes ?? ''}
              sku={reportRecord.sku ?? ''}
              downtimeEvents={reportRecord.downtime_snapshot ?? []}
            />
          </div>
        </div>
      )}

      {printRecord && (
        <div className="print-only">
          <ShiftReport
            shift={printRecord.shift_name as Shift}
            date={printRecord.record_date}
            hours={printRecord.hours?.length ? printRecord.hours : getActiveHours(printRecord.shift_name as Shift, [])}
            boardData={printRecord.board_data}
            notes={printRecord.notes ?? ''}
            sku={printRecord.sku ?? ''}
            downtimeEvents={printRecord.downtime_snapshot ?? []}
          />
        </div>
      )}

      {auditRecord && (
        <div className="modal-overlay" onClick={() => setAuditRecord(null)}>
          <div className="modal-card" style={{ maxWidth: 640, maxHeight: '80vh' }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Record History — {auditRecord.shift_name} · {auditRecord.record_date}</h2>
              <button type="button" className="modal-close-btn" onClick={() => setAuditRecord(null)} aria-label="Close">✕</button>
            </div>
            <div style={{ padding: 16, maxHeight: '60vh', overflowY: 'auto' }}>
              {auditLoading ? (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, color: 'var(--text-muted)' }}>
                  <Loader2 size={18} className="animate-spin" style={{ marginRight: 8 }} /> Loading history…
                </div>
              ) : auditEntries.length === 0 ? (
                <div style={{ padding: 16, color: 'var(--text-muted)', textAlign: 'center' }}>No history entries for this record.</div>
              ) : (
                <table className="w-full text-[13px]" style={{ minWidth: 520 }}>
                  <thead>
                    <tr className="text-left text-[11px] font-bold uppercase tracking-wide text-slate-800 border-b border-slate-200">
                      <th className="px-4 py-2.5">Action</th>
                      <th className="px-4 py-2.5">Saved By</th>
                      <th className="px-4 py-2.5">At</th>
                    </tr>
                  </thead>
                  <tbody>
                    {auditEntries.map((e) => (
                      <tr key={e.id} className="border-b border-slate-100">
                        <td className="px-4 py-3">
                          <span style={{
                            fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.3px',
                            background: e.action === 'create' ? 'var(--green-tag-bg)' : 'var(--amber-tag-bg)',
                            color: e.action === 'create' ? 'var(--green-tag-text)' : 'var(--amber-tag-text)',
                            borderRadius: 999, padding: '2px 8px',
                          }}>
                            {e.action === 'create' ? 'Created' : 'Overwritten'}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-slate-700">{e.saved_by}</td>
                        <td className="px-4 py-3 text-slate-500 text-[12px]">{new Date(e.created_at).toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}