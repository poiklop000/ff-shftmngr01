export interface OfsCounts {
  through?: number;
  rated?: number;
  out?: number;
  "out.unadjusted"?: number;
  "rated.unadjusted"?: number;
  "out.raw"?: number;
  "through.unadjusted"?: number;
}

export interface OfsCrew {
  name?: string;
  title?: string;
}

export interface OfsUser {
  name?: string;
  title?: string;
}

export interface OfsShift {
  id?: number;
  start?: number;
  startText?: string;
  duration?: number;
  type?: string;
  counts?: OfsCounts;
  $crew?: OfsCrew;
  $user?: OfsUser;
}

export interface OfsOrderProduct {
  name?: string;
  description?: string;
  SKU?: string;
}

export interface OfsOrder {
  clientId?: string;
  name?: string;
  $product?: OfsOrderProduct;
}

export interface OfsJob {
  id?: number;
  start?: number;
  startText?: string;
  duration?: number;
  quantity?: number;
  type?: string;
  counts?: OfsCounts;
  metadata?: {
    cansPerCarton?: string;
    ratedSpeed?: string;
    unitsToMake?: string;
    outCounterLocation?: string;
    [k: string]: string | undefined;
  };
  $order?: OfsOrder;
}

export interface OfsRunState {
  name?: string;
  description?: string;
  color?: string;
  state?: string;
  start?: number;
  duration?: number;
}

export interface OfsProcessCounter {
  rate?: number;
  value?: number;
}

export interface OfsProcess {
  throughunitpersister?: OfsProcessCounter;
  unitsout?: OfsProcessCounter;
  outunitpersister?: OfsProcessCounter;
  unitsin?: OfsProcessCounter;
  ratedunitpersister?: OfsProcessCounter;
}

export interface OfsWorkcentre {
  name?: string;
  title?: string;
  console?: string;
  consoletimezone?: string;
  consoletimeText?: string;
}

export interface OfsLiveStatus {
  timestamp?: number;
  timestampText?: string;
  workcentre?: OfsWorkcentre;
  shift?: OfsShift;
  job?: OfsJob;
  runstate?: OfsRunState;
  process?: OfsProcess;
  states?: Record<string, number>;
}

export interface OfsStatusResponse {
  console: string;
  endpoint: string;
  fetchedAt: string;
  data: OfsLiveStatus;
}

export interface OfsReasonCategory {
  category?: string;
  description?: string;
}

export interface OfsReason {
  description?: string;
  category?: OfsReasonCategory;
  downtimeType?: string;
}

export interface OfsSpanItem {
  id?: number;
  type?: string;
  state?: string;
  start?: number;
  startText?: string;
  duration?: number;
  counts?: OfsCounts;
  $reason?: OfsReason;
  $crew?: OfsCrew;
  $user?: OfsUser;
  class?: string;
}

export interface OfsSpansData {
  downtime?: OfsSpanItem;
  items?: OfsSpanItem[];
  series?: unknown;
  timestampText?: string;
}

export interface OfsSpansResponse {
  console: string;
  endpoint: string;
  fetchedAt: string;
  data: OfsSpansData;
}

async function fetchOfsEndpoint<T>(
  endpoint: string,
  signal?: AbortSignal,
): Promise<T> {
  const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ofs-status?endpoint=${endpoint}`;
  const json = await fetchOfsRaw(url, signal);
  if (!json || !json.data) {
    throw new Error(json?.error || "Unexpected response from server function");
  }
  return json.data as T;
}

// Short-TTL in-memory cache for the slow OFS calls (express spans + hour
// summary). Revisiting the same page or re-rendering within the TTL reuses the
// cached payload instead of re-downloading the whole OFS history each time.
interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const ofsCache = new Map<string, CacheEntry<unknown>>();

function ofsCacheGet<T>(key: string): T | null {
  const entry = ofsCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    ofsCache.delete(key);
    return null;
  }
  return entry.value as T;
}

function ofsCacheSet<T>(key: string, value: T, ttlMs: number): void {
  ofsCache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

const EXPRESS_SPANS_CACHE_TTL_MS = 60_000;
const HOUR_SUMMARY_CACHE_TTL_MS = 30_000;

const OFS_FETCH_TIMEOUT_MS = 15000;

// Master kill switch short-circuit. When the ofs-status edge function reports
// the OFS data collection is disabled (503), remember it locally for a short
// window so the live polling screens stop hammering the endpoint. The window
// lets devices auto-recover within ~30s once an admin re-enables OFS.
const OFS_DISABLED_WINDOW_MS = 30_000;
let ofsDisabledUntil = 0;

export function isOfsDisabled(): boolean {
  return Date.now() < ofsDisabledUntil;
}

/**
 * Fetches a URL from the OFS edge function with a 15s timeout so the UI never
 * sits on a loading spinner indefinitely if the OFS system is unreachable.
 * Respects an externally-provided AbortSignal (e.g. for component cleanup).
 */
async function fetchOfsRaw(
  url: string,
  signal?: AbortSignal,
): Promise<{ data?: unknown; error?: string }> {
  if (isOfsDisabled()) {
    throw new Error('OFS data collection is disabled');
  }
  const ctrl = new AbortController();
  const onExternalAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', onExternalAbort, { once: true });
  }
  const timer = setTimeout(() => ctrl.abort(), OFS_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
        "Content-Type": "application/json",
      },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      if (res.status === 503 && (body?.code === 'ofs_disabled' || /disabled/i.test(body?.error ?? ''))) {
        ofsDisabledUntil = Date.now() + OFS_DISABLED_WINDOW_MS;
      }
      throw new Error(body.error || `Request failed (${res.status})`);
    }
    return (await res.json()) as { data?: unknown; error?: string };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onExternalAbort);
  }
}

export type LineStateClass = 'running' | 'slow' | 'setup' | 'downtime' | 'planned' | 'idle';

export const LINE_STATE_COLORS: Record<LineStateClass, string> = {
  running: '#16a34a',
  slow: '#9acd32',
  setup: '#eab308',
  downtime: '#dc2626',
  planned: '#2563eb',
  idle: '#94a3b8',
};

export function classifyLineState(runstate: OfsRunState | undefined): LineStateClass {
  const state = runstate?.state?.toLowerCase() ?? '';
  // Order matters: a single state string can contain multiple keywords.
  // "job.setup.running" contains both "setup" and "running", so setup must
  // be checked before running. "unplanned" contains the substring "planned",
  // so it must be checked before "planned" to avoid misclassifying unplanned
  // downtime as planned (blue instead of red). "running.slow" contains
  // "running", so slow must be checked before running.
  if (state.includes('setup')) return 'setup';
  if (state.includes('unplanned')) return 'downtime';
  if (state.includes('planned')) return 'planned';
  if (state.includes('downtime')) return 'downtime';
  if (state.includes('slow')) return 'slow';
  if (state.includes('running')) return 'running';
  if (state.includes('shift') || state.includes('job')) return 'idle';
  return 'idle';
}

export async function fetchOfsStatus(signal?: AbortSignal): Promise<OfsLiveStatus> {
  return fetchOfsEndpoint<OfsLiveStatus>("live/status", signal);
}

export async function fetchOfsSpans(signal?: AbortSignal): Promise<OfsSpansData> {
  return fetchOfsEndpoint<OfsSpansData>("live/spans", signal);
}

export interface ExpressSpanComment {
  commentId: number;
  author: string;
  userName: string;
  text: string;
  commentTimestamp: number;
  systemPost: boolean;
  crewId?: number;
  crewName?: string;
}

export interface ExpressSpan {
  id: number;
  type: string;
  spanType?: string;
  spanClass?: string;
  start: number;
  end?: number;
  reasonId?: number;
  reasonName?: string;
  reasonDescription?: string;
  reasonType?: string;
  reasonCategory?: number;
  reasonCategoryName?: string;
  crewId?: number;
  shiftId?: number;
  shiftStart?: number;
  shiftEnd?: number;
  jobId?: number;
  jobStart?: number;
  jobEnd?: number;
  jobQuantity?: number;
  orderId?: number;
  orderQuantity?: number;
  userId?: number;
  comments?: ExpressSpanComment[];
}

interface ExpressSpansResponse {
  spans: ExpressSpan[];
}

export async function fetchExpressSpans(
  start?: number,
  end?: number,
  signal?: AbortSignal,
): Promise<ExpressSpan[]> {
  const key = `express_spans:${start ?? 'all'}:${end ?? 'all'}`;
  const cached = ofsCacheGet<ExpressSpan[]>(key);
  if (cached) return cached;

  let endpoint = "data/express/spans";
  if (start !== undefined && end !== undefined) {
    endpoint += `&start=${start}&end=${end}`;
  }
  const data = await fetchOfsEndpoint<ExpressSpansResponse>(endpoint, signal);
  const spans = data.spans ?? [];
  ofsCacheSet(key, spans, EXPRESS_SPANS_CACHE_TTL_MS);
  return spans;
}

export interface OfsHourSummaryCounts {
  units?: number;
}

export interface OfsHourSummarySpanSummary {
  duration?: number;
  counts?: Record<string, OfsHourSummaryCounts>;
}

export interface OfsHourSummaryItem {
  id: number;
  start: number;
  end: number;
  startText: string;
  endText: string;
  spanSummaries?: Record<string, OfsHourSummarySpanSummary>;
}

export interface OfsHourSummaryData {
  start: number;
  end: number;
  startText: string;
  endText: string;
  items: OfsHourSummaryItem[];
}

export async function fetchHourlySummary(
  startDate?: string,
  endDate?: string,
  signal?: AbortSignal,
): Promise<OfsHourSummaryData> {
  const key = `hour_summary:${startDate ?? 'all'}:${endDate ?? 'all'}`;
  const cached = ofsCacheGet<OfsHourSummaryData>(key);
  if (cached) return cached;

  let url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ofs-status?endpoint=data/summary/hour`;
  if (startDate && endDate) {
    const { start, end } = dateStrToEpochRange(startDate, endDate);
    url += `&start=${start}&end=${end}`;
  }
  const json = await fetchOfsRaw(url, signal);
  if (!json || !json.data) {
    throw new Error(json?.error || "Unexpected response from server function");
  }
  const data = json.data as OfsHourSummaryData;
  ofsCacheSet(key, data, HOUR_SUMMARY_CACHE_TTL_MS);
  return data;
}

// Convert YYYY-MM-DD date strings to epoch ms range in the OFS console
// timezone (Pacific/Auckland) so the server returns the correct window.
function dateStrToEpochRange(startDate: string, endDate: string): { start: number; end: number } {
  const startEpoch = aucklandMidnightEpoch(startDate);
  const endEpoch = aucklandMidnightEpoch(endDate) + 24 * 3600_000 - 1;
  return { start: startEpoch, end: endEpoch };
}

function aucklandMidnightEpoch(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  const utcMidnight = Date.UTC(y, m - 1, d, 0, 0, 0);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Pacific/Auckland',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(utcMidnight));
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const offsetHours = hour === 24 ? 0 : hour;
  return utcMidnight - offsetHours * 3600_000;
}
