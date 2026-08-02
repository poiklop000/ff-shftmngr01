// capture-downtime — server-side downtime + setup capture
//
// Runs on a schedule via Deno.cron so events are captured even when no browser
// is open. Also exposes an HTTP endpoint the frontend can call to trigger an
// immediate capture and get back the current status for display.
//
// Captures non-production spans from the OFS live feed:
//   - Unplanned downtime  (spanGroup "downtime", downtimeType "UNPLANNED")
//   - Planned downtime    (spanGroup "downtime", downtimeType "PLANNED")
//   - Setup / changeover  (state contains "setup")
//   - Running slow        (state contains "slow" — no reason/category from OFS,
//                          so it is recorded as "Running Slow")
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

interface OfsSpanItem {
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
  downtime?: OfsSpanItem;
  items?: OfsSpanItem[];
}

interface DowntimeEvent {
  id: number;
  console_id: string;
  console_name: string | null;
  span_id: number | null;
  state: string | null;
  downtime_type: string | null;
  reason: string | null;
  category: string | null;
  start_epoch: number;
  start_text: string | null;
  end_epoch: number | null;
  duration_ms: number | null;
  resolved: boolean;
  counts: Record<string, number> | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

function getSupabase() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("Supabase env not configured");
  return createClient(url, key, { auth: { persistSession: false } });
}

async function fetchSpans(): Promise<OfsSpansData | null> {
  const user = Deno.env.get("OFS_USER");
  const pass = Deno.env.get("OFS_PASS");
  if (!user || !pass) throw new Error("OFS credentials not configured");
  const auth = `Basic ${btoa(`${user}:${pass}`)}`;
  const res = await fetch(`${OFS_BASE}${SERVER_PATH}/live/spans`, {
    method: "GET",
    headers: { Authorization: auth, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`OFS live/spans returned ${res.status}`);
  return (await res.json()) as OfsSpansData;
}

// Dedup key: OFS emits several overlapping spans for the same event (e.g.
// "job.work.downtime.named" + "shiftStartable", or "running.slow" +
// "job.work.running.slow") that share the same start epoch and type but have
// different span IDs. We group by start + type only — NOT reason — because the
// reason may not be assigned yet when the span first appears, which would
// cause the same event to be captured twice. When duplicates are found, prefer
// the more specific span (one with a named reason, a state other than
// "shiftStartable", or a more specific dotted state like "job.work.*").
function stateSpecificity(span: OfsSpanItem): number {
  return (span.state ?? "").split(".").filter((p) => p.length > 0).length;
}

function dedupeSpans(spans: OfsSpanItem[]): OfsSpanItem[] {
  const byKey = new Map<string, OfsSpanItem>();
  for (const s of spans) {
    const type = s.$reason?.downtimeType ?? (s.state?.includes("setup") ? "SETUP" : "");
    const key = `${s.start}_${type}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, s);
      continue;
    }
    // Prefer the span with a reason; if both have one, prefer the non-shiftStartable state.
    const existingHasReason = !!(existing.$reason?.description);
    const thisHasReason = !!(s.$reason?.description);
    if (thisHasReason && !existingHasReason) {
      byKey.set(key, s);
    } else if (thisHasReason === existingHasReason) {
      const existingIsGeneric = existing.state === "shiftStartable" || existing.state === "shiftEndable";
      const thisIsGeneric = s.state === "shiftStartable" || s.state === "shiftEndable";
      if (existingIsGeneric && !thisIsGeneric) {
        byKey.set(key, s);
      } else if (existingIsGeneric === thisIsGeneric && stateSpecificity(s) > stateSpecificity(existing)) {
        // Equal footing — keep the more specific state (e.g. "job.work.running.slow"
        // over "running.slow").
        byKey.set(key, s);
      }
    }
  }
  return [...byKey.values()];
}

// Select the spans we want to record as downtime-style events: planned +
// unplanned downtime spans (identified by $reason.spanGroup), setup spans
// (identified by state containing "setup"), and running-slow spans (identified
// by state containing "slow"). Falls back to the top-level `downtime` field
// for unplanned downtime when present.
//
// OFS keeps every span in the items array with an ever-growing duration, even
// after the line has moved on to a new state. The line can only be in one
// non-production state at a time, so only the span(s) with the latest start
// time are truly active — earlier ones have ended.
function extractActiveSpans(spans: OfsSpansData | null): OfsSpanItem[] {
  if (!spans) return [];
  const items = spans.items ?? [];
  const picks: OfsSpanItem[] = [];

  for (const item of items) {
    if (!item.id || !item.start) continue;
    const reason = item.$reason;
    const isDowntime = reason?.spanGroup === "downtime";
    const isSetup = item.state?.includes("setup") ?? false;
    const isSlow = item.state?.includes("slow") ?? false;
    if (isDowntime || isSetup || isSlow) picks.push(item);
  }

  if (spans.downtime?.id && spans.downtime?.start) {
    if (!picks.some((p) => p.id === spans.downtime!.id)) {
      picks.push(spans.downtime);
    }
  }

  const deduped = dedupeSpans(picks);
  if (deduped.length === 0) return [];

  // Keep only the span(s) with the latest start time. OFS leaves ended spans
  // in the feed with growing durations; the most recent start is the current
  // state and earlier ones have concluded.
  const latestStart = Math.max(...deduped.map((s) => s.start!));
  return deduped.filter((s) => s.start === latestStart);
}

function spanToEvent(span: OfsSpanItem): Partial<DowntimeEvent> & { id: number } {
  const isSlow = span.state?.includes("slow") ?? false;
  const reason = span.$reason?.description ?? (isSlow ? "Running Slow" : null);
  const category =
    span.$reason?.$category?.description ??
    span.$reason?.$category?.category ??
    span.$reason?.category?.description ??
    span.$reason?.category?.category ??
    (isSlow ? "Running Slow" : null);
  const downtimeType =
    span.$reason?.downtimeType ??
    (span.state?.includes("setup") ? "SETUP" : isSlow ? "RUNNING_SLOW" : null);

  // Setup spans carry no $reason — synthesize a readable label from the order.
  const setupReason = !reason && downtimeType === "SETUP"
    ? (span.$order?.$product?.description ?? span.$order?.name ?? "Setup / Changeover")
    : reason;
  const setupCategory = !category && downtimeType === "SETUP" ? "Setup" : category;

  return {
    id: span.id!,
    console_id: CONSOLE,
    console_name: CONSOLE_NAME,
    span_id: span.id ?? null,
    state: span.state ?? null,
    downtime_type: downtimeType,
    reason: setupReason,
    category: setupCategory,
    start_epoch: span.start!,
    start_text: span.startText ?? null,
    end_epoch: null,
    duration_ms: span.duration ?? 0,
    resolved: false,
    counts: span.counts ?? null,
    metadata: {
      crew: span.$crew?.name ?? null,
      user: span.$user?.name ?? null,
      class: span.class ?? null,
      order: span.$order?.name ?? null,
    },
    updated_at: new Date().toISOString(),
  };
}

type CaptureAction = "inserted" | "updated" | "resolved" | "none";

interface CaptureResult {
  hasDowntime: boolean;
  action: CaptureAction;
  event: DowntimeEvent | null;
  events: DowntimeEvent[];
}

async function captureOnce(supabase: ReturnType<typeof getSupabase>): Promise<CaptureResult> {
  const spans = await fetchSpans();
  const current = extractActiveSpans(spans);
  const currentIds = new Set(current.map((s) => s.id));

  const { data: openRows } = await supabase
    .from("downtime_events")
    .select("*")
    .eq("console_id", CONSOLE)
    .eq("resolved", false);
  const openEvents = (openRows ?? []) as unknown as DowntimeEvent[];

  // Resolve any open events that are no longer in the live feed.
  const stale = openEvents.filter((e) => !currentIds.has(e.id));
  const now = Date.now();
  for (const evt of stale) {
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

  if (current.length === 0) {
    if (openEvents.length > 0) {
      return {
        hasDowntime: false,
        action: "resolved",
        event: openEvents[0] ?? null,
        events: [],
      };
    }
    return { hasDowntime: false, action: "none", event: null, events: [] };
  }

  const liveEvents: DowntimeEvent[] = [];
  let insertedAny = false;

  for (const span of current) {
    const existing = openEvents.find((e) => e.id === span.id);
    const liveDuration = span.duration ?? 0;

    if (existing) {
      const liveEvt = spanToEvent(span);
      const needsUpdate =
        (!existing.category && liveEvt.category) ||
        (!existing.reason && liveEvt.reason) ||
        (!existing.downtime_type && liveEvt.downtime_type);
      const merged: DowntimeEvent = {
        ...existing,
        duration_ms: liveDuration || (existing.duration_ms ?? 0),
        category: existing.category ?? liveEvt.category ?? null,
        reason: existing.reason ?? liveEvt.reason ?? null,
        downtime_type: existing.downtime_type ?? liveEvt.downtime_type ?? null,
      };
      if (needsUpdate) {
        await supabase
          .from("downtime_events")
          .update({
            category: merged.category,
            reason: merged.reason,
            downtime_type: merged.downtime_type,
            duration_ms: merged.duration_ms,
            updated_at: new Date().toISOString(),
          })
          .eq("id", existing.id);
      }
      liveEvents.push(merged);
      continue;
    }

    const record = spanToEvent(span);
    const { data: inserted, error } = await supabase
      .from("downtime_events")
      .upsert(record, { onConflict: "id" })
      .select()
      .single();
    if (error) throw new Error(error.message);
    liveEvents.push(inserted as unknown as DowntimeEvent);
    insertedAny = true;
  }

  const action: CaptureAction = insertedAny
    ? "inserted"
    : stale.length > 0
      ? "resolved"
      : "updated";

  return {
    hasDowntime: true,
    action,
    event: liveEvents[0] ?? null,
    events: liveEvents,
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
  // Allow GET (pg_net uses GET) and POST (frontend trigger)
  if (req.method !== "GET" && req.method !== "POST") {
    return json({ error: "Only GET and POST are supported" }, 405);
  }
  try {
    const supabase = getSupabase();
    const result = await captureOnce(supabase);
    console.log(
      `[capture-downtime] ${new Date().toISOString()} action=${result.action} hasDowntime=${result.hasDowntime} active=${result.events.length}`,
    );
    return json({ ok: true, ...result, timestamp: new Date().toISOString() });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(
      `[capture-downtime] ${new Date().toISOString()} error:`,
      message,
    );
    return json({ ok: false, error: message }, 502);
  }
});
