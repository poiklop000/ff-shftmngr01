import { useEffect, useMemo, useState } from 'react';
import { Activity, Loader2, RefreshCw, History } from 'lucide-react';
import { fetchAlertHistory, type AlertLogRow } from '@/lib/alertLog';

const ALERT_TYPE_COLORS: Record<string, { bg: string; color: string; border: string }> = {
  occurred: { bg: 'var(--red-tag-bg)', color: 'var(--red-tag-text)', border: 'var(--red-tag-border)' },
  escalation: { bg: 'var(--amber-tag-bg)', color: 'var(--amber-tag-text)', border: 'var(--amber-tag-border)' },
  resolved: { bg: 'var(--green-tag-bg)', color: 'var(--green-tag-text)', border: 'var(--green-tag-border)' },
  recurring: { bg: 'var(--amber-tag-bg)', color: 'var(--amber-tag-text)', border: 'var(--amber-tag-border)' },
  test: { bg: '#ede9fe', color: '#6b21a8', border: '#ddd6fe' },
};

function typeColor(type: string): { bg: string; color: string; border: string } {
  return ALERT_TYPE_COLORS[type] ?? { bg: 'var(--slate-tag-bg)', color: 'var(--slate-tag-text)', border: 'var(--slate-tag-border)' };
}

function formatAuckland(iso: string): string {
  const dt = new Date(iso);
  if (isNaN(dt.getTime())) return iso;
  return new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Pacific/Auckland',
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(dt);
}

export function AlertHistory() {
  const [rows, setRows] = useState<AlertLogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('All');
  const [search, setSearch] = useState('');

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setRows(await fetchAlertHistory(200));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load alert history');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const filtered = useMemo(() => {
    let list = rows;
    if (filter !== 'All') {
      list = list.filter((r) => r.alert_type === filter);
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter((r) =>
        (r.message ?? '').toLowerCase().includes(q) ||
        (r.reason ?? '').toLowerCase().includes(q) ||
        (r.category ?? '').toLowerCase().includes(q) ||
        (r.product ?? '').toLowerCase().includes(q),
      );
    }
    return list;
  }, [rows, filter, search]);

  const counts = useMemo(() => {
    const sent = rows.filter((r) => r.status === 'sent').length;
    const failed = rows.length - sent;
    const byType: Record<string, number> = {};
    for (const r of rows) byType[r.alert_type] = (byType[r.alert_type] ?? 0) + 1;
    return { sent, failed, byType };
  }, [rows]);

  return (
    <div className="card card-blue">
      <h3 style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <span>
          <History size={15} style={{ verticalAlign: 'text-bottom', marginRight: 6 }} />
          Teams Alert History
        </span>
        <button type="button" className="tab-btn tab-btn-blue" style={{ padding: '4px 10px', fontSize: 11 }} onClick={load} disabled={loading}>
          {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} Refresh
        </button>
      </h3>

      <div className="card-row" style={{ flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, fontWeight: 800, color: 'var(--blue-tag-text)', backgroundColor: 'var(--blue-tag-bg)', border: '1px solid var(--blue-tag-border)', borderRadius: 999, padding: '3px 10px', whiteSpace: 'nowrap' }}>
            {counts.sent} sent
          </span>
          {counts.failed > 0 && (
            <span style={{ fontSize: 11, fontWeight: 800, color: 'var(--red-tag-text)', backgroundColor: 'var(--red-tag-bg)', border: '1px solid var(--red-tag-border)', borderRadius: 999, padding: '3px 10px', whiteSpace: 'nowrap' }}>
              {counts.failed} failed
            </span>
          )}
          {Object.entries(counts.byType).map(([t, n]) => (
            <span key={t} style={{ fontSize: 11, fontWeight: 700, color: 'var(--slate-tag-text)', backgroundColor: 'var(--slate-tag-bg)', border: '1px solid var(--slate-tag-border)', borderRadius: 999, padding: '3px 10px', whiteSpace: 'nowrap' }}>
              {t}: {n}
            </span>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto', flexWrap: 'wrap' }}>
          <input
            type="search"
            placeholder="Search message, reason…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ fontSize: 12, padding: '4px 8px', borderRadius: 6, border: '1px solid var(--input-border)', backgroundColor: 'var(--input-bg)', color: 'var(--input-text)', maxWidth: 180 }}
          />
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            style={{ fontSize: 12, padding: '4px 8px', borderRadius: 6, border: '1px solid var(--input-border)', color: 'var(--input-text)', backgroundColor: 'var(--input-bg)' }}
          >
            <option value="All">All Types</option>
            {['occurred', 'escalation', 'resolved', 'recurring', 'test'].map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </div>
      </div>

      {error && (
        <div style={{ fontSize: 12, color: 'var(--danger-text)', background: 'var(--danger-bg)', border: '1px solid var(--danger-border)', borderRadius: 8, padding: '8px 10px', fontWeight: 600, marginTop: 10 }}>
          {error}
        </div>
      )}

      {loading && rows.length === 0 ? (
        <div className="card-scroll" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 16, fontSize: 13, color: 'var(--text-muted)', fontWeight: 600 }}>
          <Activity size={15} /> Loading alert history…
        </div>
      ) : filtered.length === 0 ? (
        <div className="card-scroll" style={{ padding: 16, fontSize: 12, color: 'var(--text-muted)', fontWeight: 500 }}>
          {rows.length === 0 ? 'No alerts have been sent yet. Send a test alert from Settings to verify the pipeline.' : 'No alerts match the current filter.'}
        </div>
      ) : (
        <div className="card-scroll" style={{ marginTop: 10, maxHeight: 270 }}>
          <table className="w-full text-[13px]" style={{ minWidth: 720 }}>
            <thead>
              <tr className="text-left text-[11px] font-bold uppercase tracking-wide text-slate-800 border-b border-slate-200">
                <th className="px-4 py-2.5">When</th>
                <th className="px-4 py-2.5">Type</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5">Message</th>
                <th className="px-4 py-2.5">Product</th>
                <th className="px-4 py-2.5">Reason / Category</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                const c = typeColor(r.alert_type);
                return (
                  <tr key={r.id} className="border-b border-slate-100 hover:bg-slate-50 transition-colors">
                    <td className="px-4 py-3 text-slate-700 whitespace-nowrap">{formatAuckland(r.created_at)}</td>
                    <td className="px-4 py-3">
                      <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.3px', background: c.bg, color: c.color, border: `1px solid ${c.border}`, borderRadius: 999, padding: '2px 10px', whiteSpace: 'nowrap' }}>
                        {r.alert_type}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span style={{ fontSize: 11, fontWeight: 700, color: r.status === 'sent' ? 'var(--success-text)' : 'var(--danger-text)' }}>
                        {r.status === 'sent' ? 'Sent' : 'Failed'}
                        {r.http_status != null ? ` · ${r.http_status}` : ''}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-slate-700">{r.message ?? '-'}</td>
                    <td className="px-4 py-3 text-slate-600">{r.product || '-'}</td>
                    <td className="px-4 py-3 text-slate-600" style={{ maxWidth: 260 }}>
                      {r.reason ?? '-'}{r.category && r.reason !== r.category ? ` · ${r.category}` : ''}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
