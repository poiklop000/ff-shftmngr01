import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Calculator, ClipboardList, Activity, TimerOff, Settings, Calendar, Clock, BarChart3, Shield, LogOut, Database, Moon, Sun, Maximize2, Minimize2, MoreVertical } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useTheme } from '@/lib/theme';
import { AnalyticsView } from '@/components/AnalyticsView';
import { CalculatorView } from '@/components/CalculatorView';
import { DowntimeHistory } from '@/components/DowntimeHistory';
import { LiveLineStatus } from '@/components/LiveLineStatus';
import { MonitoringView } from '@/components/MonitoringView';
import { SettingsModal } from '@/components/SettingsModal';
import { LoginView } from '@/components/LoginView';
import { AdminView } from '@/components/AdminView';
import { SavedRecordsView } from '@/components/SavedRecordsView';
import { signOut, fetchProfile, type AppProfile } from '@/lib/auth';
import { ROLE_ACCESS, VALID_VIEWS, userAllowedViews, type View } from '@/lib/access';
import { supabase } from '@/lib/supabase';
import {
  computeHourlyOutputs,
  computeDowntimeLogs,
  createEmptyShiftData,
  generateHours,
  getActiveHours,
  getDefaultRowCount,
  loadAppData,
  saveAppData,
  SHIFT_LABELS,
  SHIFT_LIST,
  todayStr,
  type AppData,
  type CalcInputs,
  type CustomConfig,
  type Shift,
  type ShiftRow,
  type ToggleState,
} from '@/types';
import { fetchCounterLogsByDate } from '@/lib/counterLogs';
import { fetchHourlyRatedSpeeds } from '@/lib/jobSnapshots';
import { fetchDowntimeForShift, type DowntimeEvent } from '@/lib/downtime';
import { saveMonitoringRecord, loadMonitoringRecord, buildActiveJobSnapshot, type ActiveJobSnapshot } from '@/lib/monitoring';
import { fetchOfsStatus } from '@/lib/ofs';
import { syncAllData } from '@/lib/captureSync';

const VIEW_KEY = 'canning_calc_view';

// Deep-clone the data for an immutable update, but keep the customHours array
// reference stable. Without this, every edit gives customHours a new identity,
// which re-triggers effects that depend on it (e.g. the jobs and timeline
// fetches in MonitoringView) and causes an infinite refetch loop.
function cloneData(prev: AppData): AppData {
  const next = structuredClone(prev) as AppData;
  next.customHours = prev.customHours;
  return next;
}

export default function App() {
  const [view, setView] = useState<View>(() => {
    const saved = localStorage.getItem(VIEW_KEY) as View | null;
    return saved && VALID_VIEWS.includes(saved) ? saved : 'tracker';
  });
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Deep links from Teams alert cards (e.g. .../#/analytics) select the matching view.
  useEffect(() => {
    const applyHash = () => {
      const m = window.location.hash.match(/^#\/(\w+)/);
      if (m && (VALID_VIEWS as string[]).includes(m[1])) setView(m[1] as View);
    };
    applyHash();
    window.addEventListener('hashchange', applyHash);
    return () => window.removeEventListener('hashchange', applyHash);
  }, []);
  const [data, setData] = useState<AppData>(() => loadAppData());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [hasSavedRecord, setHasSavedRecord] = useState(false);
  const [lastSavedBy, setLastSavedBy] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncTick, setSyncTick] = useState(0);

  const { theme, toggleTheme } = useTheme();
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [kiosk, setKiosk] = useState(() => {
    try {
      return localStorage.getItem('canning_kiosk') === 'true';
    } catch {
      return false;
    }
  });

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      document.documentElement.requestFullscreen().catch(() => {});
    }
  }, []);

  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  // Kiosk mode: enter fullscreen automatically on load and keep the preference.
  useEffect(() => {
    try {
      localStorage.setItem('canning_kiosk', String(kiosk));
    } catch {
      // ignore storage failures
    }
    if (kiosk) {
      document.documentElement.requestFullscreen().catch(() => {});
    }
  }, [kiosk]);

  const [authReady, setAuthReady] = useState(false);
  const [session, setSession] = useState<Awaited<ReturnType<typeof supabase.auth.getSession>>['data']['session']>(null);
  const [profile, setProfile] = useState<AppProfile | null>(null);

  // Restore the persisted auth session and keep it in sync with Supabase.
  // Sessions persist in localStorage, so users stay signed in across visits.
  useEffect(() => {
    let mounted = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      setSession(data.session);
      setAuthReady(true);
      if (data.session) {
        fetchProfile(data.session.user.id)
          .then((p) => {
            if (!mounted) return;
            if (p && !p.is_active) {
              setProfile(null);
              supabase.auth.signOut();
            } else {
              setProfile(p);
            }
          })
          .catch(() => { if (mounted) setProfile(null); });
      }
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      if (!s) setProfile(null);
    });
    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  // Close the header menu when clicking outside it or pressing Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  const handleSignOut = async () => {
    await signOut();
    setProfile(null);
  };

  const handleSync = async () => {
    setSyncing(true);
    setSyncMessage(null);
    setSyncError(null);
    try {
      const outcome = await syncAllData();
      if (outcome.allOk) {
        setSyncMessage('Sync complete — downtime, counters and jobs updated.');
        setSyncTick((t) => t + 1);
      } else {
        setSyncError(
          `Sync finished with issues: ${outcome.results.filter((r) => !r.ok).map((r) => `${r.name} (${r.status ?? r.error ?? 'failed'})`).join(', ')}.`,
        );
      }
    } catch (err) {
      setSyncError(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncing(false);
    }
  };

  useEffect(() => {
    saveAppData(data);
  }, [data]);

  // Hide the bottom nav bar when the mobile soft keyboard opens so it
  // doesn't cover the input the user is typing into.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const threshold = 150;
    const update = () => setKeyboardOpen(window.innerHeight - vv.height > threshold);
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);

  useEffect(() => {
    localStorage.setItem(VIEW_KEY, view);
  }, [view]);

  const handleCalcChange = useCallback((field: keyof CalcInputs, value: string) => {
    setData((prev) => ({
      ...prev,
      calc: { ...prev.calc, [field]: value },
    }));
  }, []);

  const handleCalcUpdate = useCallback(() => {
    saveAppData(data);
  }, [data]);

  const handleCalcClear = useCallback(() => {
    if (!confirm('WARNING: You are about to clear all Filler Calculator inputs. Do you want to proceed?')) return;
    setData((prev) => ({
      ...prev,
      calc: {
        product: '', size: '', plan: '', speed: '', uvol: '', mvol: '',
        ratio: '', counter: '', bowl: '', layer: '', pallet: '',
      },
    }));
  }, []);

  const handleShiftChange = useCallback((shift: Shift) => {
    setData((prev) => ({ ...prev, shift }));
  }, []);

  const handleRowChange = useCallback(
    (shift: Shift, index: number, field: keyof ShiftRow, value: string) => {
      setData((prev) => {
        const next = cloneData(prev);
        const row = next.db[shift].rows[index] as unknown as Record<string, unknown>;
        row[field] = value;
        return next;
      });
    },
    []
  );

  const handleToggle = useCallback(
    (shift: Shift, index: number, field: 'q' | 's') => {
      setData((prev) => {
        const next = cloneData(prev);
        const row = next.db[shift].rows[index];
        const current = row[field] as ToggleState;
        row[field] = ((current + 1) % 3) as ToggleState;
        return next;
      });
    },
    []
  );

  const handleMetaChange = useCallback(
    (shift: Shift, field: 'date' | 'sku' | 'notes', value: string) => {
      setData((prev) => {
        const next = cloneData(prev);
        if (field === 'date') {
          next.date = value;
          next.db[shift].date = value;
        } else if (field === 'sku') {
          next.sku[shift] = value;
        } else {
          next.notes[shift] = value;
        }
        return next;
      });
    },
    []
  );

  const handleClearShift = useCallback((shift: Shift) => {
    setData((prev) => {
      const next = cloneData(prev);
      if (shift === 'Custom') {
        next.db[shift] = createEmptyShiftData(0);
        next.customHours = [];
      } else {
        next.db[shift] = createEmptyShiftData(getDefaultRowCount(shift));
      }
      next.notes[shift] = '';
      // The product list (SKUs) is intentionally kept — it is the shift's
      // product info and is not part of the per-interval data being wiped.
      next.db[shift].date = '';
      return next;
    });
  }, []);

  const handleCustomConfigChange = useCallback((config: CustomConfig) => {
    setData((prev) => ({ ...prev, customConfig: config }));
  }, []);

  const handleGenerateCustom = useCallback(() => {
    setData((prev) => {
      if (prev.customConfig.start === prev.customConfig.end) {
        alert('Start time and end time cannot be the same.');
        return prev;
      }
      const hours = generateHours(prev.customConfig.start, prev.customConfig.end, prev.customConfig.interval);
      const newCount = hours.length;
      const oldRows = prev.db['Custom'].rows;
      const rows: Record<number, ShiftRow> = {};
      for (let i = 0; i < newCount; i++) {
        rows[i] = oldRows[i] ? { ...oldRows[i] } : { spd: '', out: '', log: '', yld: '', scr: '', q: 0, s: 0 };
      }
      const next = cloneData(prev);
      next.customHours = hours;
      next.db['Custom'].rows = rows;
      return next;
    });
  }, []);

  // Check whether a saved record exists for the current date + shift
  // whenever either changes. This enables/disables the Load Record button.
  useEffect(() => {
    if (!data.date) {
      setHasSavedRecord(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const record = await loadMonitoringRecord(data.date, data.shift);
        if (!cancelled) {
          setHasSavedRecord(!!record);
          setLastSavedBy(record?.saved_by ?? '');
        }
      } catch {
        if (!cancelled) {
          setHasSavedRecord(false);
          setLastSavedBy('');
        }
      }
    })();
    return () => { cancelled = true; };
  }, [data.date, data.shift]);

  const handleSaveRecord = useCallback(async () => {
    if (!data.date) {
      throw new Error('Select a date first at the top of the monitoring table.');
    }
    const shift = data.shift;
    const boardData = data.db[shift];
    if (Object.keys(boardData.rows).length === 0) {
      throw new Error('No monitoring rows for this shift. Generate the table first.');
    }

    let activeJob: ActiveJobSnapshot | null = null;
    try {
      const status = await fetchOfsStatus();
      activeJob = await buildActiveJobSnapshot(status);
    } catch {
      // If OFS is unreachable, save with null active job
    }

    let downtimeSnapshot: DowntimeEvent[] = [];
    try {
      downtimeSnapshot = await fetchDowntimeForShift(shift, data.customHours, data.date);
    } catch {
      // If downtime fetch fails, save with empty snapshot
    }

    let counterSnapshot: Awaited<ReturnType<typeof fetchCounterLogsByDate>> = [];
    try {
      counterSnapshot = await fetchCounterLogsByDate(data.date);
    } catch {
      // If counter fetch fails, save with empty snapshot
    }

    await saveMonitoringRecord({
      date: data.date,
      shift,
      boardData,
      notes: data.notes[shift] ?? '',
      sku: data.sku[shift] ?? '',
      activeJob,
      downtimeSnapshot,
      counterSnapshot,
      hours: getActiveHours(shift, data.customHours),
      savedBy: profile?.display_name ?? '',
    });
    setHasSavedRecord(true);
  }, [data.date, data.shift, data.db, data.notes, data.sku, data.customHours, profile?.display_name]);

  const handleLoadRecord = useCallback(async () => {
    if (!data.date) {
      throw new Error('Select a date first at the top of the monitoring table.');
    }
    const shift = data.shift;
    const record = await loadMonitoringRecord(data.date, shift);
    if (!record) {
      throw new Error(`No saved record found for ${shift} on ${data.date}.`);
    }
    setData((prev) => {
      const next = cloneData(prev);
      next.db[shift] = record.board_data;
      next.notes[shift] = record.notes ?? '';
      next.sku[shift] = record.sku ?? '';
      next.db[shift].date = record.record_date;
      return next;
    });
  }, [data.date, data.shift]);

  const handleExportReport = useCallback(() => {
    const dateStr = data.date || '';
    const original = document.title;
    const reportName = `FF_${data.shift}${dateStr ? `_${dateStr}` : ''}`;
    document.title = reportName;

    const restore = () => {
      document.title = original;
      window.removeEventListener('afterprint', restore);
    };
    window.addEventListener('afterprint', restore);

    // On mobile the print sheet is async, so restoring right after window.print()
    // would wipe the title before the user picks "Save to PDF". afterprint fires
    // once the sheet closes. Fallback timeout in case the event never fires.
    window.setTimeout(restore, 60_000);

    window.print();
  }, [data.date, data.shift]);



function timeStrHour(time: string): number {
  return parseInt(time.split(':')[0] ?? '0', 10);
}

/**
 * Converts an end_epoch (Unix ms) to an OFS console-time string
 * ("YYYY-MM-DD HH:MM:SS") in the factory's timezone. The factory timezone
 * offset is derived from the event's own start_epoch/start_text pair, so no
 * hardcoded timezone is needed. Returns null if endEpoch is null (ongoing).
 */
function epochToConsoleTime(
  endEpoch: number | null,
  startEpoch: number,
  startText: string | null,
): string | null {
  if (endEpoch === null || !startText) return null;
  const offsetMs = startEpoch - Date.parse(startText.replace(' ', 'T'));
  const shifted = new Date(endEpoch - offsetMs);
  const y = shifted.getFullYear();
  const m = String(shifted.getMonth() + 1).padStart(2, '0');
  const d = String(shifted.getDate()).padStart(2, '0');
  const h = String(shifted.getHours()).padStart(2, '0');
  const min = String(shifted.getMinutes()).padStart(2, '0');
  const s = String(shifted.getSeconds()).padStart(2, '0');
  return `${y}-${m}-${d} ${h}:${min}:${s}`;
}

  // Pull counter readings from the database for the selected date, compute
  // per-hour output, and fill the Actual Output column for the current shift.
  // For overnight shifts (start hour >= 12), also fetch the next day because
  // the shift spans midnight (e.g. a 20:00 shift on date D runs into D+1).
  const handleImportCounter = useCallback(async () => {
    const date = data.date;
    if (!date) {
      throw new Error('Select a date first at the top of the monitoring table.');
    }
    const shift = data.shift;
    const hours = getActiveHours(shift, data.customHours);
    const shiftStartStr = hours[0]?.split(' - ')[0]?.trim();
    const isOvernight = shiftStartStr ? timeStrHour(shiftStartStr) >= 12 : false;

    const logs = await fetchCounterLogsByDate(date);
    if (isOvernight) {
      const nextDate = new Date(`${date}T00:00:00`);
      nextDate.setDate(nextDate.getDate() + 1);
      const ny = nextDate.getFullYear();
      const nm = String(nextDate.getMonth() + 1).padStart(2, '0');
      const nd = String(nextDate.getDate()).padStart(2, '0');
      const nextLogs = await fetchCounterLogsByDate(`${ny}-${nm}-${nd}`);
      logs.push(...nextLogs);
    }
    if (logs.length === 0) {
      throw new Error(`No counter readings found in the database for ${date}.`);
    }
    // Rated speed per hour comes from job_snapshots, which already carries any
    // Live-page correction (capture-active-jobs layers job_overrides onto it).
    const ratedSpeeds = await fetchHourlyRatedSpeeds(date, shift, data.customHours);
    setData((prev) => {
      const activeHours = getActiveHours(shift, prev.customHours);
      const outputs = computeHourlyOutputs(logs, activeHours, prev.date);
      const rowCount = Object.keys(prev.db[shift].rows).length;
      if (rowCount === 0) {
        throw new Error('No monitoring rows for this shift. Generate the table first.');
      }
      const next = cloneData(prev);
      for (let i = 0; i < rowCount; i++) {
        if (outputs[i] !== undefined) {
          next.db[shift].rows[i].out = outputs[i]!;
        }
        // Only fill Rated Speed where the user hasn't typed a value yet.
        if (ratedSpeeds[i] !== undefined && next.db[shift].rows[i].spd.trim() === '') {
          next.db[shift].rows[i].spd = ratedSpeeds[i]!.toLocaleString();
        }
      }
      return next;
    });
  }, [data.date, data.shift, data.customHours]);

  // Pull downtime events from the database for the selected date, map them onto
  // the shift's time intervals, and fill the Downtime Logs column.
  // For overnight shifts (start hour >= 12), also fetch the next day because
  // the shift spans midnight (e.g. a 20:00 shift on date D runs into D+1).
  const handleImportDowntime = useCallback(async () => {
    const date = data.date;
    if (!date) {
      throw new Error('Select a date first at the top of the monitoring table.');
    }
    const shift = data.shift;

    const events = await fetchDowntimeForShift(shift, data.customHours, date);
    if (events.length === 0) {
      throw new Error(`No downtime events found in the database for ${date}.`);
    }
    setData((prev) => {
      const activeHours = getActiveHours(shift, prev.customHours);
      const rowCount = Object.keys(prev.db[shift].rows).length;
      if (rowCount === 0) {
        throw new Error('No monitoring rows for this shift. Generate the table first.');
      }
      const logs = computeDowntimeLogs(
        events.map((e) => ({ startText: e.start_text, endText: epochToConsoleTime(e.end_epoch, e.start_epoch, e.start_text), category: e.category, reason: e.reason, comments: e.comments })),
        activeHours,
        date
      );
      const next = cloneData(prev);
      for (let i = 0; i < rowCount; i++) {
        if (logs[i] !== undefined) {
          next.db[shift].rows[i].log = logs[i]!;
        }
      }
      return next;
    });
  }, [data.date, data.shift, data.customHours]);

  const calcMemo = useMemo(() => data.calc, [data.calc]);

  // Login gate: show a loading splash while the persisted session is restored,
  // then the login screen until a valid session exists.
  if (!authReady) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: 'var(--app-bg, #f8fafc)', color: 'var(--app-fg, #1e293b)' }}>
        <div style={{ fontWeight: 700, color: 'var(--text-muted, #64748b)' }}>Loading...</div>
      </div>
    );
  }

  if (!session) {
    return <LoginView onSuccess={(p) => setProfile(p)} />;
  }

  const currentUserId = session.user.id;
  const allowedViews = profile ? userAllowedViews(profile) : ROLE_ACCESS.operator;
  const effectiveView: View = allowedViews.includes(view) ? view : allowedViews[0]!;

  const ALL_NAV: { id: View; label: string; Icon: LucideIcon }[] = [
    { id: 'live', label: 'Live', Icon: Activity },
    { id: 'tracker', label: 'Monitoring', Icon: ClipboardList },
    { id: 'downtime', label: 'Downtime', Icon: TimerOff },
    { id: 'calculator', label: 'Calculator', Icon: Calculator },
    { id: 'analytics', label: 'Analytics', Icon: BarChart3 },
    { id: 'saved-records', label: 'Saved Records', Icon: Database },
    { id: 'admin', label: 'Admin', Icon: Shield },
  ];
  const navItems = ALL_NAV.filter((n) => allowedViews.includes(n.id));

  return (
    <div style={{ minHeight: '100vh', backgroundColor: 'var(--app-bg, #f8fafc)', color: 'var(--app-fg, #1e293b)' }}>
      <div className="app-bar">
        <div className="app-bar-inner">
          <span className="app-bar-title">Free-Flow Manufacturing<br />Krones Canning Line Console</span>
          <div className="app-bar-menu" ref={menuRef}>
            <button
              type="button"
              className="app-bar-menu-btn"
              onClick={() => setMenuOpen((v) => !v)}
              aria-label="Menu"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              title="Menu"
            >
              <MoreVertical size={20} />
            </button>
            {menuOpen && (
              <div className="app-bar-dropdown" role="menu">
                {profile && (
                  <div className="app-bar-dropdown-user">
                    <span className="app-bar-dropdown-user-name">{profile.display_name}</span>
                    <span className="app-bar-dropdown-user-role">Signed in</span>
                  </div>
                )}
                <button
                  type="button"
                  role="menuitem"
                  className="app-bar-dropdown-item"
                  onClick={toggleTheme}
                >
                  {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
                  <span>{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="app-bar-dropdown-item"
                  onClick={toggleFullscreen}
                >
                  {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
                  <span>{isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="app-bar-dropdown-item"
                  onClick={() => { setSettingsOpen(true); setMenuOpen(false); }}
                >
                  <Settings size={16} />
                  <span>Settings</span>
                </button>
                <div className="app-bar-dropdown-divider" />
                <button
                  type="button"
                  role="menuitem"
                  className="app-bar-dropdown-item app-bar-dropdown-item-danger"
                  onClick={handleSignOut}
                >
                  <LogOut size={16} />
                  <span>Logout</span>
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="app-bar-controls no-print">
          <div className="app-bar-ctrl-group">
            <Calendar size={14} className="text-white/80" />
            <span className="app-bar-ctrl-label">Date</span>
            <input
              type="date"
              className="app-bar-date-input"
              value={data.date || ''}
              max={todayStr()}
              onChange={(e) => handleMetaChange(data.shift, 'date', e.target.value)}
            />
          </div>
          <div className="app-bar-ctrl-group">
            <Clock size={14} className="text-white/80" />
            <span className="app-bar-ctrl-label">Shift</span>
            <select
              className="app-bar-shift-select"
              value={data.shift}
              onChange={(e) => handleShiftChange(e.target.value as Shift)}
            >
              {SHIFT_LIST.map((s) => (
                <option key={s} value={s}>{SHIFT_LABELS[s]}</option>
              ))}
            </select>
          </div>
        </div>

        {data.shift === 'Custom' && (
          <div className="app-bar-custom no-print">
            <div className="app-bar-ctrl-group">
              <span className="app-bar-ctrl-label">Start</span>
              <input
                type="time"
                className="app-bar-time-input"
                value={data.customConfig.start}
                onChange={(e) => handleCustomConfigChange({ ...data.customConfig, start: e.target.value })}
              />
            </div>
            <div className="app-bar-ctrl-group">
              <span className="app-bar-ctrl-label">End</span>
              <input
                type="time"
                className="app-bar-time-input"
                value={data.customConfig.end}
                onChange={(e) => handleCustomConfigChange({ ...data.customConfig, end: e.target.value })}
              />
            </div>
            <div className="app-bar-ctrl-group">
              <span className="app-bar-ctrl-label">Interval</span>
              <select
                className="app-bar-shift-select app-bar-interval-select"
                value={data.customConfig.interval}
                onChange={(e) => handleCustomConfigChange({ ...data.customConfig, interval: parseInt(e.target.value, 10) })}
              >
                <option value={60}>1 Hour</option>
                <option value={30}>30 Minutes</option>
                <option value={15}>15 Minutes</option>
                <option value={120}>2 Hours</option>
              </select>
            </div>
            <button type="button" className="app-bar-custom-btn" onClick={handleGenerateCustom}>
              Generate Table
            </button>
          </div>
        )}
      </div>

      <div className="sm-container" style={{ paddingTop: 20, paddingBottom: 80 }}>
        {effectiveView === 'calculator' ? (
          <CalculatorView
            calc={calcMemo}
            onChange={handleCalcChange}
            onUpdate={handleCalcUpdate}
            onClear={handleCalcClear}
          />
        ) : effectiveView === 'live' ? (
          <LiveLineStatus
            currentShift={data.shift}
            customHours={data.customHours}
            date={data.date}
          />
        ) : effectiveView === 'downtime' ? (
          <DowntimeHistory
            date={data.date}
            currentShift={data.shift}
            customHours={data.customHours}
          />
        ) : effectiveView === 'analytics' ? (
          <AnalyticsView syncTick={syncTick} />
        ) : effectiveView === 'saved-records' ? (
          <SavedRecordsView />
        ) : effectiveView === 'admin' ? (
          <AdminView
            currentUserId={currentUserId}
            syncing={syncing}
            syncMessage={syncMessage}
            syncError={syncError}
            onSync={handleSync}
          />
        ) : (
          <MonitoringView
            db={data.db}
            notes={data.notes}
            sku={data.sku}
            currentShift={data.shift}
            customHours={data.customHours}
            date={data.date}

            onRowChange={handleRowChange}
            onToggle={handleToggle}
            onMetaChange={handleMetaChange}
            onClearShift={handleClearShift}
            onExportReport={handleExportReport}
            onImportCounter={handleImportCounter}
            onImportDowntime={handleImportDowntime}
            onSaveRecord={handleSaveRecord}
            onLoadRecord={handleLoadRecord}
            hasSavedRecord={hasSavedRecord}
            lastSavedBy={lastSavedBy}
          />
        )}

        <div className="footer">
          Web Apps Console v3.01 - Created by <strong>Kelvin George</strong>
        </div>
      </div>

      <nav className={`bottom-tab-bar${keyboardOpen ? ' bottom-tab-bar-hidden' : ''}`} aria-label="Section navigation" aria-hidden={keyboardOpen} style={{ ['--n' as string]: String(navItems.length) }}>
        <span className="bottom-tab-indicator" style={{ ['--i' as string]: String(navItems.findIndex((n) => n.id === effectiveView)) }} aria-hidden="true" />
        {navItems.map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            className={`bottom-tab-btn ${effectiveView === id ? 'active' : ''}`}
            onClick={() => setView(id)}
            aria-current={effectiveView === id ? 'page' : undefined}
          >
            <Icon size={22} aria-hidden="true" />
            <span className="bottom-tab-label">{label}</span>
          </button>
        ))}
      </nav>

      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} kiosk={kiosk} onKioskChange={setKiosk} />
    </div>
  );
}
