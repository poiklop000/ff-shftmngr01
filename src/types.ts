export type Shift = 'Morning' | 'Night' | '1st' | '2nd' | '3rd' | 'Custom';

export type ToggleState = 0 | 1 | 2;

export interface ShiftRow {
  spd: string;
  out: string;
  log: string;
  yld: string;
  scr: string;
  q: ToggleState;
  s: ToggleState;
}

export interface ShiftData {
  rows: Record<number, ShiftRow>;
  notes: string;
  sku: string;
  date: string;
}

export type ShiftDb = Record<Shift, ShiftData>;

export interface CustomConfig {
  start: string;
  end: string;
  interval: number;
}

export interface CalcInputs {
  product: string;
  size: string;
  plan: string;
  speed: string;
  uvol: string;
  mvol: string;
  ratio: string;
  counter: string;
  bowl: string;
  layer: string;
  pallet: string;
}

export interface CounterLogEntry {
  time: string;    // HH:MM when the reading was captured
  counter: number;  // cumulative filler counter reading
  startText?: string; // full OFS console time "YYYY-MM-DD HH:MM:SS.mmm" (optional, for date-aware filtering)
}

export interface AppData {
  db: ShiftDb;
  notes: Record<Shift, string>;
  sku: Record<Shift, string>;
  customConfig: CustomConfig;
  customHours: string[];
  shift: Shift;
  date: string;
  calc: CalcInputs;
  counterLogs: Record<Shift, CounterLogEntry[]>;
}

export const DEFAULT_SHIFT_ROW: ShiftRow = {
  spd: '',
  out: '',
  log: '',
  yld: '',
  scr: '',
  q: 0,
  s: 0,
};

export const SHIFT_LIST: Shift[] = ['Morning', 'Night', '1st', '2nd', '3rd', 'Custom'];

export const SHIFT_LABELS: Record<Shift, string> = {
  Morning: 'Morning Shift (06:00 - 18:00)',
  Night: 'Night Shift (18:00 - 06:00)',
  '1st': '1st Shift (06:00 - 14:00)',
  '2nd': '2nd Shift (14:00 - 22:00)',
  '3rd': '3rd Shift (22:00 - 06:00)',
  Custom: 'Custom Interval',
};

export function getDefaultRowCount(shift: Shift): number {
  if (shift === 'Morning' || shift === 'Night') return 12;
  return 8;
}

export function createEmptyShift(count: number): Record<number, ShiftRow> {
  const rows: Record<number, ShiftRow> = {};
  for (let i = 0; i < count; i++) rows[i] = { ...DEFAULT_SHIFT_ROW };
  return rows;
}

export function createEmptyShiftData(count: number): ShiftData {
  return {
    rows: createEmptyShift(count),
    notes: '',
    sku: '',
    date: '',
  };
}

export function createEmptyDb(): ShiftDb {
  const db = {} as ShiftDb;
  SHIFT_LIST.forEach((s) => {
    db[s] = createEmptyShiftData(s === 'Custom' ? 0 : getDefaultRowCount(s));
  });
  return db;
}

export function createEmptyAppData(): AppData {
  return {
    db: createEmptyDb(),
    notes: SHIFT_LIST.reduce((acc, s) => { acc[s] = ''; return acc; }, {} as Record<Shift, string>),
    sku: SHIFT_LIST.reduce((acc, s) => { acc[s] = ''; return acc; }, {} as Record<Shift, string>),
    customConfig: { start: '06:00', end: '14:00', interval: 60 },
    customHours: [],
    shift: 'Morning',
    date: '',
    calc: {
      product: '', size: '', plan: '', speed: '', uvol: '', mvol: '',
      ratio: '', counter: '', bowl: '', layer: '', pallet: '',
    },
    counterLogs: SHIFT_LIST.reduce((acc, s) => { acc[s] = []; return acc; }, {} as Record<Shift, CounterLogEntry[]>),
  };
}

const STORAGE_KEY = 'canning_calc_db';
const NOTES_KEY = 'canning_calc_notes';
const SKU_KEY = 'canning_calc_sku';
const SHIFT_KEY = 'canning_calc_shift';
const CUSTOM_CONFIG_KEY = 'canning_calc_custom_config';
const DATE_KEY = 'canning_calc_tx-date';
const COUNTER_LOGS_KEY = 'canning_calc_counter_logs';
const CALC_PREFIX = 'canning_calc_';
const CALC_INPUT_IDS = ['tx-product', 'dr-size', 'tx-plan', 'tx-speed', 'tx-uvol', 'tx-mvol', 'tx-ratio', 'tx-counter', 'tx-bowl', 'tx-layer', 'tx-pallet'] as const;

export function loadAppData(): AppData {
  const base = createEmptyAppData();

  try {
    const savedDb = localStorage.getItem(STORAGE_KEY);
    if (savedDb) {
      const parsed = JSON.parse(savedDb) as Partial<ShiftDb>;
      SHIFT_LIST.forEach((s) => {
        if (parsed[s] && parsed[s]!.rows) {
          const count = s === 'Custom' ? (Object.keys(parsed[s]!.rows).length) : getDefaultRowCount(s);
          for (let i = 0; i < count; i++) {
            const r = parsed[s]!.rows[i];
            base.db[s].rows[i] = r ? { ...DEFAULT_SHIFT_ROW, ...r } : { ...DEFAULT_SHIFT_ROW };
          }
        }
      });
    }
  } catch { /* ignore */ }

  try {
    const savedNotes = localStorage.getItem(NOTES_KEY);
    if (savedNotes) {
      const parsed = JSON.parse(savedNotes) as Record<Shift, string>;
      SHIFT_LIST.forEach((s) => { base.notes[s] = parsed[s] ?? ''; });
    }
  } catch { /* ignore */ }

  try {
    const savedSku = localStorage.getItem(SKU_KEY);
    if (savedSku) {
      const parsed = JSON.parse(savedSku) as Record<Shift, string>;
      SHIFT_LIST.forEach((s) => { base.sku[s] = parsed[s] ?? ''; });
    }
  } catch { /* ignore */ }

  try {
    const savedShift = localStorage.getItem(SHIFT_KEY) as Shift | null;
    if (savedShift && SHIFT_LIST.includes(savedShift)) base.shift = savedShift;
  } catch { /* ignore */ }

  try {
    const savedCustom = localStorage.getItem(CUSTOM_CONFIG_KEY);
    if (savedCustom) {
      const parsed = JSON.parse(savedCustom) as CustomConfig;
      base.customConfig = { ...base.customConfig, ...parsed };
      base.customHours = generateHours(base.customConfig.start, base.customConfig.end, base.customConfig.interval);
    }
  } catch { /* ignore */ }

  try {
    const savedDate = localStorage.getItem(DATE_KEY);
    if (savedDate) base.date = savedDate;
  } catch { /* ignore */ }

  try {
    const savedLogs = localStorage.getItem(COUNTER_LOGS_KEY);
    if (savedLogs) {
      const parsed = JSON.parse(savedLogs) as Record<Shift, CounterLogEntry[]>;
      SHIFT_LIST.forEach((s) => { base.counterLogs[s] = Array.isArray(parsed[s]) ? parsed[s]! : []; });
    }
  } catch { /* ignore */ }

  try {
    CALC_INPUT_IDS.forEach((id) => {
      const val = localStorage.getItem(CALC_PREFIX + id);
      if (val !== null) base.calc[calcIdToKey(id)] = val;
    });
  } catch { /* ignore */ }

  return base;
}

function calcIdToKey(id: string): keyof CalcInputs {
  const map: Record<string, keyof CalcInputs> = {
    'tx-product': 'product', 'dr-size': 'size', 'tx-plan': 'plan', 'tx-speed': 'speed',
    'tx-uvol': 'uvol', 'tx-mvol': 'mvol', 'tx-ratio': 'ratio', 'tx-counter': 'counter',
    'tx-bowl': 'bowl', 'tx-layer': 'layer', 'tx-pallet': 'pallet',
  };
  return map[id];
}

export function saveAppData(data: AppData) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data.db));
    localStorage.setItem(NOTES_KEY, JSON.stringify(data.notes));
    localStorage.setItem(SKU_KEY, JSON.stringify(data.sku));
    localStorage.setItem(SHIFT_KEY, data.shift);
    localStorage.setItem(CUSTOM_CONFIG_KEY, JSON.stringify(data.customConfig));
    localStorage.setItem(DATE_KEY, data.date);
    localStorage.setItem(COUNTER_LOGS_KEY, JSON.stringify(data.counterLogs));
    (Object.keys(data.calc) as (keyof CalcInputs)[]).forEach((k) => {
      const id = calcKeyToId(k);
      localStorage.setItem(CALC_PREFIX + id, data.calc[k]);
    });
  } catch { /* ignore quota */ }
}

function calcKeyToId(key: keyof CalcInputs): string {
  const map: Record<keyof CalcInputs, string> = {
    product: 'tx-product', size: 'dr-size', plan: 'tx-plan', speed: 'tx-speed',
    uvol: 'tx-uvol', mvol: 'tx-mvol', ratio: 'tx-ratio', counter: 'tx-counter',
    bowl: 'tx-bowl', layer: 'tx-layer', pallet: 'tx-pallet',
  };
  return map[key];
}

export function todayStr(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export function formatTime(totalMinutes: number): string {
  const m = ((totalMinutes % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const min = m % 60;
  return String(h).padStart(2, '0') + ':' + String(min).padStart(2, '0');
}

export function generateHours(startStr: string, endStr: string, intervalMinutes: number): string[] {
  const [sh, sm] = startStr.split(':').map(Number);
  const [eh, em] = endStr.split(':').map(Number);
  const start = sh * 60 + sm;
  let end = eh * 60 + em;
  if (end <= start) end += 1440;
  const result: string[] = [];
  let cursor = start;
  while (cursor < end) {
    result.push(formatTime(cursor) + ' - ' + formatTime(cursor + intervalMinutes));
    cursor += intervalMinutes;
  }
  return result;
}

export function getActiveHours(shift: Shift, customHours: string[]): string[] {
  if (shift === 'Morning') return generateHours('06:00', '18:00', 60);
  if (shift === 'Night') return generateHours('18:00', '06:00', 60);
  if (shift === '1st') return generateHours('06:00', '14:00', 60);
  if (shift === '2nd') return generateHours('14:00', '22:00', 60);
  if (shift === '3rd') return generateHours('22:00', '06:00', 60);
  if (shift === 'Custom') return customHours;
  return [];
}

export function formatNumberField(raw: string): string {
  const clean = raw.replace(/,/g, '').trim();
  if (clean === '' || isNaN(parseFloat(clean))) return '';
  const parts = clean.split('.');
  const intPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return parts.length > 1 ? `${intPart}.${parts[1]}` : intPart;
}

export function parseNumber(raw: string): number {
  return parseFloat((raw || '').replace(/,/g, '')) || 0;
}

/**
 * Given a list of counter log entries (per-hour throughput from OFS) and the
 * active shift hours (e.g. ["06:00 - 07:00", "07:00 - 08:00", ...]), map each
 * reading to the interval it starts in. OFS reports throughput for the hour
 * starting at the timestamp, so the 06:00 reading is the output for 06:00-07:00.
 *
 * Returns a map: row index -> output string (formatted with thousands separators).
 */
export function computeHourlyOutputs(
  logs: CounterLogEntry[],
  hours: string[],
  shiftDate: string
): Record<number, string> {
  const result: Record<number, string> = {};
  if (logs.length === 0 || hours.length === 0) return result;

  const shiftStartStr = hours[0]!.split(' - ')[0]!.trim();
  const shiftStartMin = timeStrToMinutes(shiftStartStr);

  const lastHourStr = hours[hours.length - 1]!.split(' - ')[1]!.trim();
  const shiftEndMin = shiftTimeToMinutes(lastHourStr, shiftStartMin);

  // Convert each reading to "minutes since shift-date midnight" (Auckland
  // console time), filtering to the shift window so readings from adjacent
  // days don't collide with same-HH:MM readings on the shift day.
  const readings = logs
    .map((l) => ({
      min: l.startText
        ? consoleTimeToShiftMinutes(l.startText, shiftDate)
        : shiftTimeToMinutes(l.time, shiftStartMin),
      counter: l.counter,
    }))
    .filter((r) => r.min >= shiftStartMin && r.min < shiftEndMin)
    .sort((a, b) => a.min - b.min);

  // Each OFS hourly reading is the throughput for the hour starting at its
  // timestamp, so match it to the interval whose start equals the reading time.
  hours.forEach((interval, i) => {
    const [startStr] = interval.split(' - ').map((s) => s.trim());
    if (!startStr) return;
    const intervalStartMin = shiftTimeToMinutes(startStr, shiftStartMin);
    const reading = readings.find((r) => r.min === intervalStartMin);
    if (reading && reading.counter > 0) {
      result[i] = reading.counter.toLocaleString();
    }
  });

  return result;
}

/**
 * Converts an "HH:MM" time string to shifted minutes-of-day, so that times
 * before the shift start (e.g. 00:30 during a 22:00 night shift) roll forward
 * by 1440 minutes to line up with the shift's clock face.
 */
function shiftTimeToMinutes(time: string, shiftStartMin: number): number {
  const min = timeStrToMinutes(time);
  if (min < shiftStartMin) return min + 1440;
  return min;
}

/**
 * Maps downtime events onto shift intervals (the Downtime Logs column).
 *
 * Each event has a start and (optional) end in OFS console local time
 * ("YYYY-MM-DD HH:MM:SS.mmm"). Since the console time includes the full date,
 * we convert both event times and the shift window to "minutes since the
 * shift date's midnight" in Auckland wall-clock time. This is
 * timezone-independent — no epoch/offset math is needed.
 *
 * For overnight shifts this prevents events from the previous shift's early
 * morning (e.g. 26 Jul 00:10) from landing in the selected overnight shift's
 * 00:00-01:00 bucket (which should show 27 Jul events). Events that started
 * before the shift but were still running during it (e.g. Planned Cleaning
 * from 21:13 to 00:48) are included via overlap.
 *
 * Returns a map: row index -> log text (newline-separated when multiple).
 */
export function computeDowntimeLogs(
  events: Array<{ startText: string | null; endText: string | null; category: string | null; reason: string | null; comments?: { text: string; systemPost: boolean }[] | null }>,
  hours: string[],
  shiftDate: string,
  nowText?: string | null
): Record<number, string> {
  const result: Record<number, string> = {};
  const shiftStartStr = hours.length > 0 ? hours[0]!.split(' - ')[0]!.trim() : null;
  if (!shiftStartStr) return result;
  const shiftStartMin = timeStrToMinutes(shiftStartStr);

  const lastHourStr = hours[hours.length - 1]!.split(' - ')[1]!.trim();
  const shiftEndMin = shiftTimeToMinutes(lastHourStr, shiftStartMin);

  const buckets: Record<number, Array<{ label: string; startMin: number; durationMin: number; comments: string[] }>> = {};

  for (const evt of events) {
    if (!evt.startText) continue;

    const startMin = consoleTimeToShiftMinutes(evt.startText, shiftDate);
    const endMin = evt.endText
      ? consoleTimeToShiftMinutes(evt.endText, shiftDate)
      : nowText
        ? consoleTimeToShiftMinutes(nowText, shiftDate)
        : startMin + 60; // assume up to an hour if still ongoing

    // Skip events that don't overlap this shift's time window. Both event
    // times and shift window are in "minutes since shift-date midnight"
    // (Auckland console time), so this comparison is timezone-independent.
    if (endMin <= shiftStartMin || startMin >= shiftEndMin) {
      continue;
    }

    const durationMin = endMin - startMin;
    const category = evt.category?.trim();
    const reason = evt.reason?.trim() || 'Downtime';
    const label = category ? `${category} - ${reason}` : reason;
    const operatorComments = evt.comments
      ?.filter((c) => !c.systemPost && c.text?.trim())
      .map((c) => c.text.trim()) ?? [];

    hours.forEach((interval, i) => {
      const [iStart, iEnd] = interval.split(' - ').map((s) => s.trim());
      if (!iStart || !iEnd) return;
      const iStartMin = shiftTimeToMinutes(iStart, shiftStartMin);
      const iEndMin = shiftTimeToMinutes(iEnd, shiftStartMin);
      // overlap check
      if (startMin < iEndMin && endMin > iStartMin) {
        if (!buckets[i]) buckets[i] = [];
        buckets[i].push({ label, startMin, durationMin, comments: operatorComments });
      }
    });
  }

  for (const [i, entries] of Object.entries(buckets)) {
    // Longest downtime first so the biggest hits show at the top of the cell.
    entries.sort((a, b) => b.durationMin - a.durationMin);
    // Combine events with the same category + reason into one line with an
    // occurrence count, and merge all operator comments from those occurrences
    // on the line below.
    const groups = new Map<string, { label: string; count: number; comments: string[]; startMin: number; durationMin: number }>();
    for (const { label, durationMin, comments } of entries) {
      const g = groups.get(label) ?? { label, count: 0, comments: [], startMin: 0, durationMin };
      g.count += 1;
      if (durationMin > g.durationMin) g.durationMin = durationMin;
      if (comments) g.comments.push(...comments);
      groups.set(label, g);
    }
    result[Number(i)] = Array.from(groups.values())
      .sort((a, b) => b.durationMin - a.durationMin)
      .map((g) => {
        const countLabel = g.count > 1 ? `${g.label} (${g.count}x)` : g.label;
        const uniqueComments = Array.from(new Set(g.comments));
        return uniqueComments.length > 0
          ? `${countLabel}\n    *(${uniqueComments.join('; ')})`
          : countLabel;
      })
      .join('\n');
  }

  return result;
}

/**
 * Filters a list of timestamped entries to those that fall within the active
 * shift window for the given shift/date. Each entry must expose either an OFS
 * console-time string ("YYYY-MM-DD HH:MM:SS[.mmm]", via consoleTimeKey) or an
 * "HH:MM" hour label (via hourKey). Entries with a consoleTime are matched by
 * full date so overnight shifts don't pick up adjacent days; entries with only
 * an hour label are matched against the shift's time-of-day range.
 *
 * Reused by LiveLineStatus (Production Counter Summary) and DowntimeHistory so
 * both views stay in sync with the date + shift selected on the monitoring page.
 *
 * When `endTimeKey` is provided (e.g. the event's console end time), events
 * that started before the shift window are still kept when they are ongoing or
 * overlap into the window — a planned stop that began at 04:54 must keep
 * showing after the 06:00 shift change instead of disappearing.
 */
export function getShiftWindowMinutes(shift: Shift, customHours: string[]): { startMin: number; endMin: number } {
  const hours = getActiveHours(shift, customHours);
  if (hours.length === 0) return { startMin: 0, endMin: 0 };
  const shiftStartMin = timeStrToMinutes(hours[0]!.split(' - ')[0]!.trim());
  const lastHourStr = hours[hours.length - 1]!.split(' - ')[1]!.trim();
  return { startMin: shiftStartMin, endMin: shiftTimeToMinutes(lastHourStr, shiftStartMin) };
}

export function filterByShiftWindow<T>(
  entries: T[],
  shift: Shift,
  customHours: string[],
  shiftDate: string,
  consoleTimeKey: (e: T) => string | null | undefined,
  hourKey?: (e: T) => string | null | undefined,
  endTimeKey?: (e: T) => string | null | undefined,
): T[] {
  const hours = getActiveHours(shift, customHours);
  if (hours.length === 0 || !shiftDate) return [];
  const { startMin: shiftStartMin, endMin: shiftEndMin } = getShiftWindowMinutes(shift, customHours);

  return entries.filter((e) => {
    const consoleTime = consoleTimeKey(e);
    if (consoleTime) {
      const min = consoleTimeToShiftMinutes(consoleTime, shiftDate);
      if (min >= shiftStartMin && min < shiftEndMin) return true;
      if (endTimeKey && min < shiftStartMin) {
        const endStr = endTimeKey(e);
        if (!endStr) return true;
        return consoleTimeToShiftMinutes(endStr, shiftDate) > shiftStartMin;
      }
      return false;
    }
    if (hourKey) {
      const h = hourKey(e);
      if (!h) return false;
      const min = shiftTimeToMinutes(h.trim(), shiftStartMin);
      return min >= shiftStartMin && min < shiftEndMin;
    }
    return false;
  });
}

function timeStrToMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/**
 * Converts an OFS console-time string ("YYYY-MM-DD HH:MM:SS.mmm") to minutes
 * since the shift date's midnight in Auckland wall-clock time. By using the
 * full date (not just HH:MM), this distinguishes events on different calendar
 * days — e.g. 26 Jul 00:10 (previous shift's early morning) vs 27 Jul 00:10
 * (selected overnight shift's early morning). The result is timezone-independent
 * because both the event time and the shift date are in the same console tz.
 */
export function consoleTimeToShiftMinutes(consoleTime: string, shiftDate: string): number {
  const evtDate = consoleTime.slice(0, 10); // "YYYY-MM-DD"
  const timeMatch = consoleTime.match(/(\d{2}):(\d{2})/);
  const minOfDay = timeMatch
    ? parseInt(timeMatch[1]!, 10) * 60 + parseInt(timeMatch[2]!, 10)
    : 0;

  // Whole days between shift date and event date, times 1440, plus minOfDay.
  const [sy, sm, sd] = shiftDate.split('-').map(Number);
  const [ey, em, ed] = evtDate.split('-').map(Number);
  const shiftDateMs = Date.UTC(sy, sm - 1, sd);
  const evtDateMs = Date.UTC(ey, em - 1, ed);
  const dayDiff = Math.round((evtDateMs - shiftDateMs) / 86_400_000);
  return dayDiff * 1440 + minOfDay;
}
