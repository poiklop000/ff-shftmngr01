import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  Boxes,
  Clock,
  Gauge,
  Loader2,
  Package,
  RefreshCw,
  TimerOff,
  TrendingUp,
  AlertTriangle,
  User as UserIcon,
} from 'lucide-react';
import { loadLiveIntervals } from '@/lib/liveConfig';
import { useAutoRefresh } from '@/lib/useAutoRefresh';
import { fetchAlertHistory, type AlertLogRow } from '@/lib/alertLog';
import { fetchOfsStatus, classifyLineState, LINE_STATE_COLORS, type OfsRunState, type LineStateClass } from '@/lib/ofs';
import { fetchHourlySummaryByDate, type HourlySummaryEntry } from '@/lib/counterLogs';
import { fetchDowntimeByDate, fetchDowntimeBetween, formatDuration, type DowntimeEvent } from '@/lib/downtime';
import { filterByShiftWindow, SHIFT_LABELS, type Shift } from '@/types';
import { DowntimeTypeBadge } from '@/components/DowntimeTypeBadge';

interface DashboardViewProps {
  date: string;
  currentShift: Shift;
  customHours: string[];
  isAdmin?: boolean;
}

interface SummaryBundle {
  downtime: DowntimeEvent[];
  hourly: HourlySummaryEntry[];
  reasons: { reason: string; category: string; ms: number; count: number }[];
}

function dateOffsetStr(date: string, days: number): string {
  const d = new Date(`${date || new Date().toISOString().slice(0, 10)}T00:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatElapsedMs(ms: number): string {
  if (!ms || ms <= 0) return '-';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

function formatEstFinish(remaining: number, speedPerHour: number): string {
  if (speedPerHour <= 0 || remaining <= 0) return '--:--:--';
  const totalSec = (remaining / speedPerHour) * 3600;
  const finish = new Date(Date.now() + totalSec * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(finish.getHours())}:${pad(finish.getMinutes())}:${pad(finish.getSeconds())}`;
}

export function DashboardView({ date, currentShift, customHours, isAdmin = false }: DashboardViewProps) {
  const [liveMs, setLiveMs] = useState(3000);
  const [summaryMs, setSummaryMs] = useState(30000);

  useEffect(() => {
    let mounted = true;
    loadLiveIntervals()
      .then((intervals) => {
        if (!mounted) return;
        setLiveMs(intervals.liveMs);
        setSummaryMs(intervals.summaryMs);
      })
      .catch(() => {});
    return () => { mounted = false; };
  }, []);

  const statusHook = useAutoRefresh(() => fetchOfsStatus(), liveMs);
  const status = statusHook.data;

  const summaryLoader = useMemo(
    () => async (): Promise<SummaryBundle> => {
      const today = date || new Date().toISOString().slice(0, 10);
      const startDay = dateOffsetStr(today, -6);
      const [downtime, hourly, allEvents] = await Promise.all([
        fetchDowntimeByDate(today),
        fetchHourlySummaryByDate(today),
        fetchDowntimeBetween(`${startDay}T00:00`, `${today}T23:59`),
      ]);
      const reasons = new Map<string, { reason: string; category: string; ms: number; count: number }>();
      for (const e of allEvents) {
        const key = e.reason ?? e.category ?? 'Unknown';
        const entry = reasons.get(key) ?? { reason: e.reason ?? e.category ?? 'Unknown', category: e.category ?? '', ms: 0, count: 0 };
        entry.ms += e.duration_ms ?? 0;
        entry.count += 1;
        reasons.set(key, entry);
      }
      return {
        downtime,
        hourly,
        reasons: Array.from(reasons.values()).sort((a, b) => b.ms - a.ms).slice(0, 8),
      };
    },
    [date],
  );
  const summaryHook = useAutoRefresh(summaryLoader, summaryMs);
  const alertsHook = useAutoRefresh(
    () => (isAdmin ? fetchAlertHistory(10) : Promise.resolve([] as AlertLogRow[])),
    summaryMs,
  );

  const job = status?.job;
  const order = job?.$order;
  const product = order?.$product;
  const productName = product?.description || order?.name || 'No active job';
  const sku = product?.SKU || order?.clientId || '-';
  const target = job?.quantity ?? 0;
  const ratedSpeed = job?.metadata?.ratedSpeed ? parseInt(job.metadata.ratedSpeed, 10) : 0;
  const jobCounts = job?.counts ?? {};
  const produced = jobCounts.through || (status?.process?.unitsin?.value ?? 0);
  const progress = target > 0 ? Math.min(100, (produced / target) * 100) : 0;
  const remaining = Math.max(0, target - produced);

  const runstate = status?.runstate;
  const lineStateClass = classifyLineState(runstate);
  const stateColor = LINE_STATE_COLORS[lineStateClass];
  const currentRate = status?.process?.throughunitpersister?.rate ?? 0;

  const shift = status?.shift;
  const operator = shift?.$user?.name || '-';

  const workcentre = status?.workcentre;
  const lineName = workcentre?.name || 'Krones Canning Line';
  const consoleTime = workcentre?.consoletimeText || status?.timestampText || '-';

  const activeDowntime = useMemo(
    () => (summaryHook.data?.downtime ?? []).filter((e) => !e.resolved),
    [summaryHook.data],
  );

  const shiftSummary = useMemo(
    () => filterByShiftWindow(summaryHook.data?.hourly ?? [], currentShift, customHours, date, (e) => e.startText, (e) => e.hour),
    [summaryHook.data, currentShift, customHours, date],
  );

  // OFS labels each hour bucket with its END time, so the entry at H holds the
  // production for H-1..H. Display each entry one hour earlier so "18:00"
  // shows the output produced between 18:00 and 19:00.
  const shiftedRows = useMemo(() => {
    const rows: { hour: string; output: number }[] = [];
    for (let i = 0; i < shiftSummary.length - 1; i++) {
      rows.push({ hour: shiftSummary[i].hour, output: shiftSummary[i + 1].in });
    }
    return rows;
  }, [shiftSummary]);

  const maxReasonMs = summaryHook.data?.reasons.reduce((m, r) => Math.max(m, r.ms), 0) ?? 0;
  const alerts = alertsHook.data ?? [];

  return (
    <div>
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3 no-print">
        <div className="flex items-center gap-2">
          <Activity className="text-brand-900" size={22} />
          <h2 className="text-lg font-bold text-brand-900 m-0">Shift Dashboard</h2>
          {consoleTime !== '-' && (
            <span className="text-[12px] font-semibold text-slate-500">· {lineName}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-md text-[12px] font-bold text-white bg-brand-900 hover:bg-brand-800 transition-colors"
            onClick={() => { statusHook.refresh(); summaryHook.refresh(); alertsHook.refresh(); }}
          >
            <RefreshCw size={14} /> Refresh
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
        <DashboardStat
          icon={<Gauge size={18} />}
          label="Line State"
          value={runstate?.description || runstate?.name || '-'}
          accent={lineStateClass}
          badge={<span className="inline-block w-2.5 h-2.5 rounded-full animate-pulse" style={{ backgroundColor: stateColor }} />}
        />
        <DashboardStat
          icon={<TrendingUp size={18} />}
          label="Current Rate"
          value={`${Math.round(currentRate * 3600).toLocaleString()} /hr`}
          hint={ratedSpeed > 0 ? `Rated: ${ratedSpeed.toLocaleString()} /hr` : undefined}
          accent="blue"
        />
        <DashboardStat
          icon={<Clock size={18} />}
          label="State Time"
          value={formatStateDuration(runstate, statusHook.lastUpdated)}
          hint={runstate?.description || runstate?.name || undefined}
          accent={lineStateClass}
          badge={<span className="inline-block w-2.5 h-2.5 rounded-full animate-pulse" style={{ backgroundColor: stateColor }} />}
        />
      </div>

      <div className="card rounded-lg p-4 mb-4 border border-blue-200 bg-blue-50 text-blue-900">
        <div className="flex items-center gap-2 mb-3 pb-2 border-b border-current">
          <Package size={18} />
          <h3 className="m-0 text-sm font-bold uppercase tracking-wide">Active Job</h3>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <DashboardField label="Product" value={productName} />
          <DashboardField label="SKU" value={sku} />
          <DashboardField label="Target Quantity" value={target.toLocaleString()} />
          <DashboardField label="Rated Speed" value={ratedSpeed > 0 ? `${ratedSpeed.toLocaleString()} /hr` : '-'} />
        </div>
        <div className="mt-4">
          <div className="flex justify-between items-center mb-1.5 text-[12px] font-semibold text-blue-900">
            <span>Production Progress</span>
            <span>
              {produced.toLocaleString()} / {target.toLocaleString()} ({progress.toFixed(1)}%)
            </span>
          </div>
          <div className="w-full h-3 rounded-full bg-blue-100 overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-700"
              style={{ width: `${progress}%`, backgroundColor: stateColor }}
            />
          </div>
          <div className="flex justify-between mt-1.5 text-[11px] text-blue-700 font-medium">
            <span>Remaining: {remaining.toLocaleString()}</span>
            {remaining > 0 && (currentRate > 0 || ratedSpeed > 0) && (
              <span>Est. finish: {formatEstFinish(remaining, currentRate > 0 ? currentRate * 3600 : ratedSpeed)}</span>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        <div className="card rounded-lg p-4 border border-red-200 bg-red-50 text-red-900">
          <div className="flex items-center gap-2 mb-3 pb-2 border-b border-current">
            <AlertTriangle size={18} />
            <h3 className="m-0 text-sm font-bold uppercase tracking-wide">Active Downtime</h3>
            {activeDowntime.length > 0 && (
              <span className="ml-auto inline-block w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse" />
            )}
          </div>
          {summaryHook.loading && activeDowntime.length === 0 ? (
            <div className="flex items-center gap-2 text-[13px] font-medium text-red-700">
              <Loader2 size={15} className="animate-spin" /> Loading downtime…
            </div>
          ) : activeDowntime.length === 0 ? (
            <div className="text-[13px] font-medium text-red-700">No downtime currently in progress.</div>
          ) : (
            <div className="flex flex-col gap-2.5">
              {activeDowntime.map((e) => (
                <div key={e.id} className="rounded-md bg-white/70 border border-red-100 p-2.5">
                  <div className="flex items-center gap-2 mb-1">
                    <DowntimeTypeBadge type={e.downtime_type} />
                    <span className="text-[12px] font-bold ml-auto">{formatDuration(Date.now() - e.start_epoch)}</span>
                  </div>
                  <div className="text-[13px] font-semibold">{e.reason ?? 'No reason recorded'}</div>
                  <div className="text-[11px] text-red-700/80 mt-0.5">
                    {e.category ?? 'Uncategorised'}
                    {e.crew_name ? ` · ${e.crew_name}` : ''}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card rounded-lg p-4 border border-green-200 bg-green-50 text-green-900">
          <div className="flex items-center gap-2 mb-3 pb-2 border-b border-current">
            <Boxes size={18} />
            <h3 className="m-0 text-sm font-bold uppercase tracking-wide">
              {SHIFT_LABELS[currentShift]} · Today's Production
            </h3>
          </div>
          {shiftedRows.length === 0 ? (
            <div className="text-[13px] font-medium text-green-700">No hourly data for this shift yet.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="text-[12px] w-max min-w-full">
                <thead>
                  <tr className="text-[11px] font-bold uppercase tracking-wide text-green-800 border-b border-green-200">
                    <th className="px-2 py-1.5 text-left">Time</th>
                    <th className="px-2 py-1.5 text-right">Rated Speed</th>
                    <th className="px-2 py-1.5 text-right">Output</th>
                    <th className="px-2 py-1.5 text-right">OEE</th>
                  </tr>
                </thead>
                <tbody>
                  {shiftedRows.map((row, i) => (
                    <tr key={i} className="border-b border-green-100">
                      <td className="px-2 py-1.5 font-semibold text-left">{row.hour}</td>
                      <td className="px-2 py-1.5 text-right">{ratedSpeed > 0 ? ratedSpeed.toLocaleString() : '-'}</td>
                      <td className="px-2 py-1.5 text-right">{row.output.toLocaleString()}</td>
                      <td className="px-2 py-1.5 text-right font-semibold">
                        {ratedSpeed > 0 ? `${((row.output / ratedSpeed) * 100).toFixed(2)}%` : '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="flex items-center gap-2 mt-3 pt-2.5 border-t border-green-200 text-[12px] font-medium text-green-800">
            <UserIcon size={14} />
            <span>Operator: {operator || '-'}</span>
          </div>
        </div>
      </div>

      {(summaryHook.data?.reasons ?? []).length > 0 && (
        <div className="card rounded-lg p-4 mb-4 border border-slate-300 bg-slate-50">
          <div className="flex items-center gap-2 mb-3 pb-2 border-b border-slate-300">
            <TimerOff size={18} className="text-slate-700" />
            <h3 className="m-0 text-sm font-bold uppercase tracking-wide text-slate-800">Top Downtime Reasons (7 days)</h3>
          </div>
          <div className="flex flex-col gap-2.5">
            {(summaryHook.data?.reasons ?? []).map((r, i) => (
              <div key={i}>
                <div className="flex justify-between text-[12px] font-semibold text-slate-700 mb-1">
                  <span className="truncate" style={{ maxWidth: '65%' }}>{r.reason}</span>
                  <span>{formatDuration(r.ms)} · {r.count} {r.count === 1 ? 'event' : 'events'}</span>
                </div>
                <div className="w-full h-2.5 rounded-full bg-slate-200 overflow-hidden">
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${maxReasonMs > 0 ? (r.ms / maxReasonMs) * 100 : 0}%`, backgroundColor: ['#1d4ed8', '#dc2626', '#eab308', '#16a34a', '#9333ea', '#0e7490', '#ea580c', '#64748b'][i % 8] }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {isAdmin && (
        <div className="card rounded-lg p-4 mb-4 border border-purple-200 bg-purple-50 text-purple-900">
          <div className="flex items-center gap-2 mb-3 pb-2 border-b border-current">
            <Activity size={18} />
            <h3 className="m-0 text-sm font-bold uppercase tracking-wide">Recent Teams Alerts</h3>
          </div>
          {alerts.length === 0 ? (
            <div className="text-[13px] font-medium text-purple-700">
              {alertsHook.loading ? 'Loading alerts…' : 'No alerts sent yet.'}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {alerts.map((a) => (
                <div key={a.id} className="rounded-md bg-white/70 border border-purple-100 p-2.5 flex items-center gap-2 flex-wrap">
                  <AlertBadge type={a.alert_type} status={a.status} />
                  <span className="text-[12px] font-semibold">{a.message ?? a.alert_type}</span>
                  <span className="text-[11px] text-purple-700/80 ml-auto">{new Date(a.created_at).toLocaleString()}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="text-center text-[11px] text-slate-500 font-medium">
        <span>
          Live updated {statusHook.lastUpdated ? statusHook.lastUpdated.toLocaleTimeString() : '…'}
          {' · '}summary {summaryHook.lastUpdated ? summaryHook.lastUpdated.toLocaleTimeString() : '…'}
          {' · '}auto-refreshes
        </span>
      </div>
    </div>
  );
}

function DashboardStat({
  icon,
  label,
  value,
  hint,
  accent,
  badge,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
  accent: LineStateClass | 'blue' | 'slate';
  badge?: React.ReactNode;
}) {
  const tones: Record<string, string> = {
    running: 'border-green-200 bg-green-50 text-green-900',
    slow: 'border-lime-300 bg-lime-50 text-lime-900',
    setup: 'border-yellow-200 bg-yellow-50 text-yellow-900',
    downtime: 'border-red-200 bg-red-50 text-red-900',
    planned: 'border-blue-200 bg-blue-50 text-blue-900',
    idle: 'border-slate-200 bg-slate-50 text-slate-900',
    blue: 'border-blue-200 bg-blue-50 text-blue-900',
    slate: 'border-slate-200 bg-slate-50 text-slate-900',
  };
  return (
    <div className={`card rounded-lg p-3.5 border ${tones[accent]}`}>
      <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide opacity-80 mb-1">
        {icon}
        <span>{label}</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xl font-bold">{value}</span>
        {badge}
      </div>
      {hint && <div className="text-[11px] font-medium opacity-70 mt-0.5">{hint}</div>}
    </div>
  );
}

function DashboardField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] font-bold uppercase tracking-wide opacity-70 mb-0.5">{label}</div>
      <div className="text-[14px] font-bold">{value}</div>
    </div>
  );
}

function AlertBadge({ type, status }: { type: string; status: string }) {
  const color = status === 'sent'
    ? { bg: '#dcfce7', color: '#166534', border: '#bbf7d0' }
    : { bg: '#fee2e2', color: '#b91c1c', border: '#fecaca' };
  return (
    <span
      style={{
        background: color.bg,
        color: color.color,
        border: `1px solid ${color.border}`,
        fontSize: 10,
        fontWeight: 800,
        textTransform: 'uppercase',
        letterSpacing: '0.3px',
        borderRadius: 999,
        padding: '2px 8px',
        whiteSpace: 'nowrap',
      }}
    >
      {status === 'sent' ? 'Sent' : 'Failed'} · {type}
    </span>
  );
}

function formatStateDuration(runstate: OfsRunState | undefined, lastUpdated: Date | null): string {
  if (!runstate) return '-';
  if (runstate.start && runstate.start > 0) {
    const now = lastUpdated ? lastUpdated.getTime() : Date.now();
    return formatElapsedMs(Math.max(0, now - runstate.start));
  }
  if (runstate.duration && runstate.duration > 0) {
    return formatElapsedMs(runstate.duration);
  }
  return '-';
}
