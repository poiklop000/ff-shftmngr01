import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  Calendar,
  Check,
  History,
  Loader2,
  MessageSquare,
  RefreshCw,
  Search,
  Timer,
} from 'lucide-react';
import {
  fetchDowntimeByDate,
  formatDuration,
  formatEventDate,
  formatEventTime,
  downtimeEventEndText,
  type DowntimeComment,
  type DowntimeEvent,
} from '@/lib/downtime';
import { filterByShiftWindow, getActiveHours, SHIFT_LABELS, type Shift } from '@/types';
import { PageHelp } from '@/components/PageHelp';
import { DowntimeTypeBadge } from '@/components/DowntimeTypeBadge';
import { DowntimeEventEdit } from '@/components/DowntimeEventEdit';
import { CheckboxDropdown } from '@/components/CheckboxDropdown';

function todayStr(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function dateToStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function nextDateStr(date: string): string {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + 1);
  return dateToStr(d);
}

function isOvernightShift(shift: Shift, customHours: string[]): boolean {
  const hours = getActiveHours(shift, customHours);
  const startStr = hours[0]?.split(' - ')[0]?.trim();
  return startStr ? parseInt(startStr.split(':')[0], 10) >= 12 : false;
}

export function DowntimeHistory({
  date: globalDate,
  currentShift,
  customHours,
}: {
  date: string;
  currentShift: Shift;
  customHours: string[];
}) {
  const [events, setEvents] = useState<DowntimeEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [expandedRow, setExpandedRow] = useState<number | null>(null);
  const [textFilter, setTextFilter] = useState('');
  const [typeFilters, setTypeFilters] = useState<string[]>([]);

  const activeDate = globalDate || todayStr();

  const loadHistory = useCallback(async (date: string) => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchDowntimeByDate(date);
      if (isOvernightShift(currentShift, customHours)) {
        const nextEvents = await fetchDowntimeByDate(nextDateStr(date));
        data.push(...nextEvents);
        data.sort((a, b) => b.start_epoch - a.start_epoch);
      }
      setEvents(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load downtime history');
    } finally {
      setLoading(false);
    }
  }, [currentShift, customHours]);

  useEffect(() => {
    if (activeDate) loadHistory(activeDate);
  }, [loadHistory, activeDate]);

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    loadHistory(activeDate).finally(() => setRefreshing(false));
  }, [loadHistory, activeDate]);

  const shiftEvents = useMemo(
    () => filterByShiftWindow(events, currentShift, customHours, activeDate, (e) => e.start_text, undefined, downtimeEventEndText),
    [events, currentShift, customHours, activeDate],
  );

  const downtimeTypes = useMemo(
    () => Array.from(new Set(shiftEvents.map((e) => e.downtime_type).filter(Boolean))) as string[],
    [shiftEvents],
  );

  const filteredEvents = useMemo(() => {
    let list = shiftEvents;
    if (typeFilters.length > 0) {
      list = list.filter((e) => typeFilters.includes(e.downtime_type ?? ''));
    }
    if (textFilter.trim()) {
      const q = textFilter.trim().toLowerCase();
      list = list.filter((e) =>
        (e.reason ?? '').toLowerCase().includes(q) ||
        (e.category ?? '').toLowerCase().includes(q) ||
        (e.state ?? '').toLowerCase().includes(q),
      );
    }
    return list;
  }, [shiftEvents, typeFilters, textFilter]);

  const totalDowntimeMs = filteredEvents.reduce((sum, e) => sum + (e.duration_ms ?? 0), 0);
  const resolvedCount = filteredEvents.filter((e) => e.resolved).length;

  const dateLabel = activeDate === todayStr() ? "Today's" : activeDate;

  return (
    <div>
      <PageHelp
        title="Downtime History"
        intro="Search and review all downtime events for a given date and shift. See what stopped the line, how long it lasted, and read any operator comments."
        sections={[
          {
            title: "Searching for events",
            items: [
              "Pick a date with the date picker at the top of the page. Events load automatically for the current date.",
              "Click Search to reload the downtime events for that date and the currently selected shift.",
              "Click Refresh from OFS to pull the latest events again.",
              "Use the type dropdown to narrow to unplanned, planned, setup, or running-slow events, and the search box to find reasons, categories, or states containing your text.",
            ],
          },
          {
            title: "Reading the summary cards",
            items: [
              "Total Downtime shows the combined time lost across the currently filtered events for the selected shift.",
              "Resolved Events shows how many filtered downtime events have ended vs. still ongoing.",
            ],
          },
          {
            title: "Reading the event table",
            items: [
              "Each row is one downtime event, showing start time, category, reason, type (unplanned, planned, or setup), crew, duration, and status (Ongoing or Resolved).",
              "If an event has operator comments, a speech-bubble icon appears next to it. Click the row to expand and read the comments.",
              "Click the row again to collapse the comments.",
            ],
          },
        ]}
      />

      <div className="flex items-center justify-between mb-4 flex-wrap gap-3 no-print">
        <div className="flex items-center gap-2">
          <History className="text-brand-900" size={22} />
          <h2 className="text-lg font-bold text-brand-900 m-0">Downtime Events History</h2>
        </div>
        <button
          type="button"
          className="flex items-center gap-1.5 px-4 py-2 rounded-md text-[13px] font-bold text-white bg-brand-900 hover:bg-brand-800 transition-colors disabled:opacity-50"
          onClick={handleRefresh}
          disabled={refreshing}
        >
          {refreshing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          Refresh from OFS
        </button>
      </div>

      <div className="card rounded-lg p-4 mb-4 border border-slate-200 bg-white">
        <div className="flex items-center gap-3 flex-wrap">
          <input
            type="search"
            placeholder="Search reason, category…"
            value={textFilter}
            onChange={(e) => setTextFilter(e.target.value)}
            className="px-3 py-2 rounded-md text-[13px] border border-slate-300 focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500 w-full sm:w-64"
          />
          <CheckboxDropdown
            label="Type"
            options={downtimeTypes.map((t) => ({ value: t, label: t }))}
            selected={typeFilters}
            onChange={setTypeFilters}
          />
          <button
            type="button"
            className="flex items-center gap-1.5 px-4 py-2 rounded-md text-[13px] font-bold text-white bg-brand-700 hover:bg-brand-800 transition-colors"
            onClick={() => activeDate && loadHistory(activeDate)}
            disabled={loading || !globalDate}
          >
            <Search size={14} />
            Search
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-3 rounded-lg p-4 mb-4 border border-red-200 bg-red-50 text-red-800">
          <AlertCircle size={20} className="mt-0.5 shrink-0" />
          <div className="text-[13px]">
            <p className="font-bold m-0 mb-1">Couldn't load downtime history</p>
            <p className="m-0 text-red-700">{error}</p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
        <SummaryCard
          label="Total Downtime"
          value={formatDuration(totalDowntimeMs)}
          accent="amber"
          icon={<Timer size={16} />}
        />
        <SummaryCard
          label="Resolved Events"
          value={String(resolvedCount)}
          accent="green"
          icon={<AlertCircle size={16} />}
        />
      </div>

      <div className="card rounded-lg border border-slate-200 bg-white overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-200 bg-slate-50">
          <h3 className="m-0 text-sm font-bold uppercase tracking-wide text-slate-700">
            {SHIFT_LABELS[currentShift]} · {dateLabel} Downtime Events
          </h3>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-12 text-slate-400">
            <Loader2 size={24} className="animate-spin" />
            <span className="ml-2 text-[13px] font-medium">Loading…</span>
          </div>
        ) : shiftEvents.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-slate-400">
            <Calendar size={32} className="mb-2 opacity-50" />
            <p className="text-[13px] font-medium m-0">
              No downtime events for {SHIFT_LABELS[currentShift]} on {activeDate}
            </p>
            <p className="text-[11px] m-0 mt-1 text-slate-400">
              Click "Refresh from OFS" to pull the latest events
            </p>
          </div>
        ) : filteredEvents.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-slate-400">
            <Search size={32} className="mb-2 opacity-50" />
            <p className="text-[13px] font-medium m-0">
              No events match the current filters
            </p>
            <p className="text-[11px] m-0 mt-1 text-slate-400">
              Try clearing the search text or choosing All Types
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-left text-[11px] font-bold uppercase tracking-wide text-slate-500 border-b border-slate-200">
                  <th className="px-4 py-2.5">Start Time</th>
                  <th className="px-4 py-2.5">Category</th>
                  <th className="px-4 py-2.5">Reason</th>
                  <th className="px-4 py-2.5">Type</th>
                  <th className="px-4 py-2.5 hidden sm:table-cell">Crew</th>
                  <th className="px-4 py-2.5 text-right">Duration</th>
                  <th className="px-4 py-2.5 text-center">Status</th>
                  <th className="px-4 py-2.5 text-center">Edit</th>
                </tr>
              </thead>
              <tbody>
                {filteredEvents.map((evt) => {
                  const hasComments = evt.comments && evt.comments.length > 0;
                  const isExpanded = expandedRow === evt.id;
                  return (
                    <React.Fragment key={evt.id}>
                      <tr
                        className={`border-b border-slate-100 hover:bg-slate-50 transition-colors ${isExpanded ? 'bg-slate-50' : ''}`}
                        onClick={() => hasComments && setExpandedRow(isExpanded ? null : evt.id)}
                        style={{ cursor: hasComments ? 'pointer' : 'default' }}
                      >
                        <td className="px-4 py-3 font-medium text-slate-700 whitespace-nowrap">
                          <div className="flex items-center gap-1">
                            {hasComments && (
                              <MessageSquare size={12} className="text-brand-600 shrink-0" />
                            )}
                            <div>
                              <div>{formatEventTime(evt.start_epoch)}</div>
                              <div className="text-[11px] text-slate-400">{formatEventDate(evt.start_epoch)}</div>
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-slate-600">{evt.category ?? '—'}</td>
                        <td className="px-4 py-3 text-slate-700">{evt.reason ?? '—'}</td>
                        <td className="px-4 py-3">
                          <DowntimeTypeBadge type={evt.downtime_type} />
                        </td>
                        <td className="px-4 py-3 text-slate-600 whitespace-nowrap hidden sm:table-cell">
                          {evt.crew_name ?? <span className="text-slate-300">—</span>}
                        </td>
                        <td className="px-4 py-3 text-right font-bold text-slate-700 whitespace-nowrap">
                          <span className="inline-flex items-center gap-1.5">
                            {formatDuration(evt.duration_ms ?? 0)}
                            {evt.user_edited && (
                              <span
                                className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-brand-100 text-brand-800 text-[10px] font-bold"
                                title="Duration corrected manually"
                              >
                                <Check size={10} /> Edited
                              </span>
                            )}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-center">
                          {evt.resolved ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-100 text-green-700 text-[11px] font-bold">
                              Resolved
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-100 text-red-700 text-[11px] font-bold">
                              <span className="inline-block w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
                              Ongoing
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-center">
                          <DowntimeEventEdit event={evt} onSaved={() => loadHistory(activeDate)} />
                        </td>
                      </tr>
                      {isExpanded && hasComments && (
                        <tr className="border-b border-slate-100 bg-slate-50/50">
                          <td colSpan={8} className="px-4 py-3">
                            <CommentList comments={evt.comments!} />
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="text-center text-[11px] text-slate-400 font-medium mt-4">
        Downtime events are pulled live from OFS. Click "Refresh from OFS" to reload.
      </div>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  accent,
  icon,
}: {
  label: string;
  value: string;
  accent: 'amber' | 'green' | 'red' | 'slate';
  icon: React.ReactNode;
}) {
  const tones: Record<string, string> = {
    amber: 'border-amber-200 bg-amber-50 text-amber-900',
    green: 'border-green-200 bg-green-50 text-green-900',
    red: 'border-red-200 bg-red-50 text-red-900',
    slate: 'border-slate-200 bg-slate-50 text-slate-900',
  };
  return (
    <div className={`card rounded-lg p-3.5 border ${tones[accent]}`}>
      <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide opacity-80 mb-1">
        {icon}
        <span>{label}</span>
      </div>
      <div className="text-xl font-bold">{value}</div>
    </div>
  );
}

function CommentList({ comments }: { comments: DowntimeComment[] }) {
  return (
    <div className="space-y-2">
      <div className="text-[11px] font-bold uppercase tracking-wide text-slate-500 mb-1">
        Operator Comments
      </div>
      {comments.map((c, i) => (
        <div key={i} className="flex items-start gap-2 text-[12px] text-slate-700">
          <MessageSquare size={12} className="text-brand-500 mt-0.5 shrink-0" />
          <div>
            <span className="font-semibold">{c.userName}</span>
            {c.crewName && <span className="text-slate-400"> · {c.crewName}</span>}
            <span className="text-slate-400 ml-1.5">
              {new Date(c.commentTimestamp).toLocaleString('en-AU', {
                day: '2-digit',
                month: 'short',
                hour: '2-digit',
                minute: '2-digit',
              })}
            </span>
            <p className="m-0 mt-0.5 text-slate-700">{c.text}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

