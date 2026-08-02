// sync-spans-history — backfill and sync full downtime event history from OFS
//
// Fetches the complete span history from `/server/data/express/spans` which
// contains every downtime event (resolved and ongoing) with rich metadata:
// crew, job, shift, user, comments, reason category, etc.
//
// ALSO fetches `/server/live/spans` to capture setup/changeover spans, which
// are NOT included in the express/spans endpoint. Setup spans are identified
// by a state containing "setup". Active setup spans are upserted as ongoing
// events; when a setup span disappears from the live feed, the corresponding
// DB row is marked resolved.
//
// On each run it upserts all spans into downtime_events. Existing rows are
// updated with the latest data (e.g. resolved end times, newly added
// comments). New rows are inserted. The `source` column is set to 'history'
// for spans that come from this sync.
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const OFS_BASE = "https://free-flow.ofsxpress.com";
const CONSOLE = "OFS002";
const SERVER_PATH = `/OFS002/server`;
const CONSOLE_NAME = "Krones Canning Line";

// --- express/spans types (downtime events with rich metadata) ---

interface ExpressSpan {
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
  crewSortIndex?: number;
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
  comments?: Array<{
    commentId: number;
    author: string;
    userName: string;
    text: string;
    commentTimestamp: number;
    systemPost: boolean;
    crewId?: number;
    crewName?: string;
  }>;
}

interface ExpressSpansResponse {
  spans: ExpressSpan[];
}

// --- live/spans types (setup/changeover spans) ---

interface OfsReasonCategory {
  description?: string;
  category?: string;
}

interface OfsReason {
  description?: string;
  $category?: OfsReasonCategory;
  category?: OfsReasonCategory;
  downtimeType?: string;
  spanGroup?: string;
}

interface OfsLiveSpanItem {
  id?: number;
  type?: string;
  state?: string;
  start?: number;
  startText?: string;
  duration?: number;
  counts?: Record<string, number>;
  $reason?: OfsReason;
  $crew?: { name?: string };
  $user?: { name?: string };
  $order?: { name?: string; clientId?: string; $product?: { description?: string } };
  class?: string;
  allocated?: boolean;
}

interface OfsSpansData {
  downtime?: OfsLiveSpanItem;
  items?: OfsLiveSpanItem[];
}

function getSupabase() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("Supabase env not configured");
  return createClient(url, key, { auth: { persistSession: false } });
}

function getOfsAuth(): string {
  const user = Deno.env.get("OFS_USER");
  const pass = Deno.env.get("OFS_PASS");
  if (!user || !pass) throw new Error("OFS credentials not configured");
  return `Basic ${btoa(`${user}:${pass}`)}`;
}

// --- express/spans fetch + mapping ---

async function fetchSpansHistory(): Promise<ExpressSpan[]> {
  const auth = getOfsAuth();
  const res = await fetch(`${OFS_BASE}${SERVER_PATH}/data/express/spans`, {
    method: "GET",
    headers: { Authorization: auth, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`OFS data/express/spans returned ${res.status}`);
  const data = (await res.json()) as ExpressSpansResponse;
  return data.spans ?? [];
}

const CREW_NAMES: Record<number, string> = {
  1: "Graveyard",
  2: "Evening",
  3: "Morning",
};
function crewNameFromId(id?: number): string | null {
  if (id == null || id === 0) return null;
  return CREW_NAMES[id] ?? null;
}

function formatEpochConsole(epochMs: number): string {
  const date = new Date(epochMs);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Pacific/Auckland",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  const ms = String(epochMs % 1000).padStart(3, "0");
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}.${ms}`;
}

function expressSpanToRecord(span: ExpressSpan) {
  const end = span.end ?? 0;
  const resolved = end > 0;
  const duration = resolved ? end - span.start : Date.now() - span.start;

  const downtimeType = span.reasonType ?? null;
  const state = span.spanType ?? null;
  const startText = formatEpochConsole(span.start);

  let crewId = span.crewId ?? null;
  let crewName: string | null = null;
  if (crewId && crewId > 0) {
    crewName = crewNameFromId(crewId);
  }
  if ((!crewId || crewId === 0) && span.comments && span.comments.length > 0) {
    const firstComment = span.comments[0];
    if (firstComment.crewId && firstComment.crewId > 0) {
      crewId = firstComment.crewId;
      crewName = firstComment.crewName ?? crewNameFromId(firstComment.crewId);
    }
  }

  let userName: string | null = null;
  if (span.comments && span.comments.length > 0) {
    userName = span.comments[0].userName ?? null;
  }

  return {
    id: span.id,
    console_id: CONSOLE,
    console_name: CONSOLE_NAME,
    span_id: span.id,
    state,
    downtime_type: downtimeType,
    reason: span.reasonDescription ?? null,
    category: span.reasonCategoryName ?? null,
    start_epoch: span.start,
    start_text: startText,
    end_epoch: resolved ? end : null,
    duration_ms: duration,
    resolved,
    span_class: span.spanClass ?? null,
    span_type: span.spanType ?? null,
    reason_id: span.reasonId ?? null,
    reason_category: span.reasonCategory ?? null,
    reason_category_name: span.reasonCategoryName ?? null,
    reason_type: span.reasonType ?? null,
    crew_id: crewId,
    crew_name: crewName,
    shift_id: span.shiftId ?? null,
    shift_start: span.shiftStart ?? null,
    shift_end: span.shiftEnd ?? null,
    job_id: span.jobId ?? null,
    job_start: span.jobStart ?? null,
    job_end: span.jobEnd ?? null,
    job_quantity: span.jobQuantity ?? null,
    order_id: span.orderId ?? null,
    order_quantity: span.orderQuantity ?? null,
    user_id: span.userId ?? null,
    user_name: userName,
    comments: span.comments ?? null,
    source: "history",
    updated_at: new Date().toISOString(),
  };
}

// --- live/spans fetch + setup extraction ---

async function fetchLiveSpans(): Promise<OfsSpansData | null> {
  const auth = getOfsAuth();
  const res = await fetch(`${OFS_BASE}${SERVER_PATH}/live/spans`, {
    method: "GET",
    headers: { Authorization: auth, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`OFS live/spans returned ${res.status}`);
  return (await res.json()) as OfsSpansData;
}

// Extract only setup spans from live/spans. OFS keeps every span in the items
// array with an ever-growing duration, even after the line has moved on. The
// line can only be in one non-production state at a time, so only the span(s)
// with the latest start time are truly active.
function extractSetupSpans(spans: OfsSpansData | null): OfsLiveSpanItem[] {
  if (!spans) return [];
  const items = spans.items ?? [];
  const setupSpans = items.filter(
    (s) => s.id && s.start && (s.state?.includes("setup") ?? false),
  );
  if (setupSpans.length === 0) return [];

  // Dedupe by start time (OFS emits overlapping spans for the same event)
  const byStart = new Map<number, OfsLiveSpanItem>();
  for (const s of setupSpans) {
    const existing = byStart.get(s.start!);
    if (!existing) {
      byStart.set(s.start!, s);
      continue;
    }
    // Prefer the one with a more specific state
    const existingGeneric = existing.state === "shiftStartable" || existing.state === "shiftEndable";
    const thisGeneric = s.state === "shiftStartable" || s.state === "shiftEndable";
    if (existingGeneric && !thisGeneric) byStart.set(s.start!, s);
  }

  const deduped = [...byStart.values()];
  // Keep only the latest start — earlier setup spans have ended
  const latestStart = Math.max(...deduped.map((s) => s.start!));
  return deduped.filter((s) => s.start === latestStart);
}

function setupSpanToRecord(span: OfsLiveSpanItem) {
  const reason = span.$reason?.description ?? null;
  const setupReason = reason ??
    span.$order?.$product?.description ??
    span.$order?.name ??
    "Setup / Changeover";
  const setupCategory = span.$reason?.$category?.description ??
    span.$reason?.category?.description ?? "Setup";

  return {
    id: span.id!,
    console_id: CONSOLE,
    console_name: CONSOLE_NAME,
    span_id: span.id ?? null,
    state: span.state ?? null,
    downtime_type: "SETUP" as string,
    reason: setupReason,
    category: setupCategory,
    start_epoch: span.start!,
    start_text: span.startText ?? formatEpochConsole(span.start!),
    end_epoch: null,
    duration_ms: span.duration ?? 0,
    resolved: false,
    span_class: span.class ?? null,
    span_type: span.type ?? null,
    reason_id: null,
    reason_category: null,
    reason_category_name: null,
    reason_type: "SETUP",
    crew_id: null,
    crew_name: span.$crew?.name ?? null,
    shift_id: null,
    shift_start: null,
    shift_end: null,
    job_id: null,
    job_start: null,
    job_end: null,
    job_quantity: null,
    order_id: null,
    order_quantity: null,
    user_id: null,
    user_name: span.$user?.name ?? null,
    comments: null,
    counts: span.counts ?? null,
    metadata: {
      crew: span.$crew?.name ?? null,
      user: span.$user?.name ?? null,
      class: span.class ?? null,
      order: span.$order?.name ?? null,
    },
    source: "live",
    updated_at: new Date().toISOString(),
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }
  if (req.method !== "GET" && req.method !== "POST") {
    return json({ error: "Only GET and POST are supported" }, 405);
  }
  try {
    const supabase = getSupabase();

    // 1. Fetch downtime history from express/spans
    const spans = await fetchSpansHistory();
    console.log(`[sync-spans-history] Fetched ${spans.length} express spans from OFS`);

    // 2. Fetch live/spans for setup events
    const liveSpans = await fetchLiveSpans();
    const setupSpans = extractSetupSpans(liveSpans);
    console.log(`[sync-spans-history] Found ${setupSpans.length} active setup span(s)`);

    // 3. Resolve stale setup events — any open SETUP event whose span ID is
    //    no longer in the live feed has ended.
    const setupIds = new Set(setupSpans.map((s) => s.id!));
    const { data: openSetupRows } = await supabase
      .from("downtime_events")
      .select("id, start_epoch")
      .eq("downtime_type", "SETUP")
      .eq("resolved", false);
    const openSetup = (openSetupRows ?? []) as Array<{ id: number; start_epoch: number }>;
    const staleSetup = openSetup.filter((e) => !setupIds.has(e.id));
    const now = Date.now();
    for (const evt of staleSetup) {
      await supabase
        .from("downtime_events")
        .update({
          resolved: true,
          end_epoch: now,
          duration_ms: now - evt.start_epoch,
          updated_at: new Date().toISOString(),
        })
        .eq("id", evt.id);
    }
    if (staleSetup.length > 0) {
      console.log(`[sync-spans-history] Resolved ${staleSetup.length} stale setup event(s)`);
    }

    // 4. Convert all spans to records
    const expressRecords = spans.map(expressSpanToRecord);
    const setupRecords = setupSpans.map(setupSpanToRecord);

    // Merge: upsert all together. Setup IDs won't collide with express span
    // IDs because setup spans are excluded from the express/spans endpoint.
    const allRecords = [...expressRecords, ...setupRecords];

    let upserted = 0;
    const BATCH_SIZE = 50;

    for (let i = 0; i < allRecords.length; i += BATCH_SIZE) {
      const batch = allRecords.slice(i, i + BATCH_SIZE);
      const { data, error } = await supabase
        .from("downtime_events")
        .upsert(batch, {
          onConflict: "id",
          ignoreDuplicates: false,
        })
        .select("id");
      if (error) {
        console.error(`[sync-spans-history] Batch ${i} error:`, error.message);
        throw new Error(error.message);
      }
      upserted += data?.length ?? 0;
    }

    console.log(
      `[sync-spans-history] ${new Date().toISOString()} synced ${spans.length} express + ${setupSpans.length} setup (${upserted} upserted, ${staleSetup.length} resolved)`,
    );
    return json({
      ok: true,
      totalSpans: spans.length,
      setupSpans: setupSpans.length,
      upserted,
      resolvedSetup: staleSetup.length,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`[sync-spans-history] ${new Date().toISOString()} error:`, message);
    return json({ ok: false, error: message }, 502);
  }
});
