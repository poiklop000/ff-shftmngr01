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
  source?: string;
  alert_sent?: boolean;
  resolved_alert_sent?: boolean;
  last_escalation_minutes?: number | null;
}

function getSupabase() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("Supabase env not configured");
  return createClient(url, key, { auth: { persistSession: false } });
}

// Respects the master OFS kill switch. When `ofs_enabled` is "false" the run
// short-circuits before making any request to OFS.
async function isOfsEnabled(supabase: ReturnType<typeof getSupabase>): Promise<boolean> {
  const { data } = await supabase
    .from("app_config")
    .select("value")
    .eq("key", "ofs_enabled")
    .maybeSingle();
  return data?.value?.toLowerCase() !== "false";
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
// by state containing "slow").
//
// The top-level `downtime` field is the authoritative "is the line down right
// now" signal: OFS returns it (with id + start) only while the line is in
// planned or unplanned downtime, and omits it once the line resumes. OFS,
// however, keeps every ended downtime span in the items array with an
// ever-growing duration. Without this gate, a stale span re-inserts a brand
// new downtime_events row on every run — resetting its alert flags — even
// though the event actually ended. So downtime-group items are only considered
// while the top-level `downtime` field is present.
//
// Setup and running-slow spans carry no spanGroup and do not surface in the
// top-level `downtime` field, so they are always picked. The line can only be
// in one non-production state at a time, so only the span(s) with the latest
// start time are truly active — earlier ones have ended.
function extractActiveSpans(spans: OfsSpansData | null): OfsSpanItem[] {
  if (!spans) return [];
  const items = spans.items ?? [];
  const hasActiveDowntime = !!(spans.downtime?.id && spans.downtime?.start);
  const picks: OfsSpanItem[] = [];

  for (const item of items) {
    if (!item.id || !item.start) continue;
    const reason = item.$reason;
    const isDowntime = reason?.spanGroup === "downtime";
    const isSetup = item.state?.includes("setup") ?? false;
    const isSlow = item.state?.includes("slow") ?? false;
    if ((isDowntime && hasActiveDowntime) || isSetup || isSlow) picks.push(item);
  }

  if (hasActiveDowntime) {
    if (!picks.some((p) => p.id === spans.downtime!.id)) {
      picks.push(spans.downtime!);
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

// Enrich context for spans that carry no $reason / $crew / $user (e.g.
// running-slow and setup spans): OFS only attaches order/crew/user to the job
// (J), shift (S) and shift.job (I) spans in the same live feed, so we look up
// the latest such span that started at or before the event's start.
function contextAt(allItems: OfsSpanItem[], at: number) {
  let order: NonNullable<OfsSpanItem["$order"]> | null = null;
  let orderStart = -1;
  let crew: NonNullable<OfsSpanItem["$crew"]> | null = null;
  let crewStart = -1;
  let user: NonNullable<OfsSpanItem["$user"]> | null = null;
  for (const s of allItems) {
    if (!s.start || s.start > at) continue;
    if ((s.type === "J" || s.type === "I") && s.$order && s.start >= orderStart) {
      order = s.$order;
      orderStart = s.start;
    }
    if ((s.type === "S" || s.type === "I") && s.start >= crewStart) {
      if (s.$crew) crew = s.$crew;
      if (s.$user) user = s.$user;
      crewStart = s.start;
    }
  }
  return { order, crew, user };
}

function orderLabel(order: OfsSpanItem["$order"]): string | null {
  if (!order) return null;
  return order.$product?.description ?? order.name ?? order.clientId ?? null;
}

// Average line speed during the event as a % of rated, from the counts.
function speedPct(counts: Record<string, number> | null | undefined): number | null {
  if (!counts) return null;
  const through = counts["through"] ?? counts["through.unadjusted"];
  const rated = counts["rated"] ?? counts["rated.unadjusted"];
  if (!through || !rated || rated <= 0) return null;
  return Math.round((through / rated) * 1000) / 10;
}

function spanToEvent(span: OfsSpanItem, allItems: OfsSpanItem[]): Partial<DowntimeEvent> & { id: number } {
  const isSlow = span.state?.includes("slow") ?? false;
  const ctx = contextAt(allItems, span.start!);
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
      crew: span.$crew?.name ?? ctx.crew?.name ?? null,
      user: span.$user?.name ?? ctx.user?.name ?? null,
      class: span.class ?? null,
      order: span.$order?.name ?? orderLabel(ctx.order ?? undefined) ?? null,
      order_client_id: ctx.order?.clientId ?? null,
      speed_pct: isSlow ? speedPct(span.counts) : null,
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

// The OFS downtime_type (or synthesized type for setup/slow spans) for an item.
function eventTypeOf(span: OfsSpanItem): string | null {
  if (span.$reason?.downtimeType) return span.$reason.downtimeType;
  if (span.state?.includes("setup")) return "SETUP";
  if (span.state?.includes("slow")) return "RUNNING_SLOW";
  return null;
}

// OFS can report the same event with slightly different start epochs between
// the live feed and the express history (a few seconds to a minute of drift).
// Identity matching treats starts within this tolerance as the same event.
function startsMatch(a: number | undefined, b: number | undefined): boolean {
  if (a == null || b == null) return false;
  return Math.abs(a - b) <= 60_000;
}

// Two downtime windows overlap when each starts before the other ends.
// Ongoing windows (null end) extend to "now".
function windowsOverlap(
  aStart: number,
  aEnd: number | null,
  bStart: number,
  bEnd: number | null,
): boolean {
  const aEndAt = aEnd ?? Date.now();
  const bEndAt = bEnd ?? Date.now();
  return aStart <= bEndAt && bStart <= aEndAt;
}

async function captureOnce(supabase: ReturnType<typeof getSupabase>): Promise<CaptureResult> {
  const spans = await fetchSpans();
  const allItems = spans?.items ?? [];
  const current = extractActiveSpans(spans);
  const currentIds = new Set(current.map((s) => s.id));

  const { data: openRows } = await supabase
    .from("downtime_events")
    .select("*")
    .eq("console_id", CONSOLE)
    .eq("resolved", false);
  const openEvents = (openRows ?? []) as unknown as DowntimeEvent[];

  // OFS represents a single event with several overlapping spans that share a
  // start time but carry different span IDs over the event's life (e.g.
  // "job.setup" -> "job.setup.running", "running.slow" ->
  // "job.work.running.slow"). Deduping only works within a single run, so when
  // the active span ID changes for the same event we must adopt the existing
  // row instead of inserting a duplicate. Identity = start epoch + type.
  const adoptedIds = new Set<number>();
  // Adoption rules for rows that represent the same physical event under a
  // different span id:
  // 1. Express convergence: the express/history row and the live capture can
  //    describe the same event under different span ids (e.g. express
  //    "span.downtime.planned" vs live "job.work.downtime.named"). The express
  //    row survives sync-spans-history (its dedupe only removes source='live'
  //    rows), so we converge on it: adopt it and delete the superseded live
  //    row. That keeps a single row per event and preserves its alert flags —
  //    otherwise the live row keeps getting deleted/re-inserted, resetting
  //    created_at and alert_sent so the occurred alert re-fires every run.
  // 2. Identity = start epoch + type (OFS reports drifted starts / changed
  //    span ids for the same event over its life).
  for (const span of current) {
    const type = eventTypeOf(span);
    if (!type) continue;
    const spanReason = span.$reason?.description ?? null;
    const expressMatch = openEvents.find(
      (e) =>
        e.id !== span.id &&
        e.source === "history" &&
        e.downtime_type === type &&
        (startsMatch(e.start_epoch, span.start) ||
          (spanReason && e.reason === spanReason)) &&
        windowsOverlap(e.start_epoch, e.end_epoch, span.start, null),
    );
    const match = expressMatch ??
      openEvents.find(
        (e) => e.id !== span.id && startsMatch(e.start_epoch, span.start) && e.downtime_type === type,
      );
    if (match) adoptedIds.add(match.id);
  }

  // Resolve any open events that are no longer in the live feed (and were not
  // adopted by a span-id drift above). Rows written by sync-spans-history
  // (source='history') are owned by that function — it resolves them once OFS
  // express history reports an end — so we leave them alone.
  const stale = openEvents.filter(
    (e) => !currentIds.has(e.id) && !adoptedIds.has(e.id) && e.source !== "history",
  );
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
    const type = eventTypeOf(span);
    const spanReason = span.$reason?.description ?? null;
    let existing = openEvents.find((e) => e.id === span.id);
    let adopting = false;
    let liveDuplicate: DowntimeEvent | null = null;

    if (type) {
      // Prefer the express/history row for the same physical event (it survives
      // sync-spans-history, which never removes source='history' rows). Adopt it
      // and drop our own same-event live row so there is exactly one row per
      // event — deleting the live row alone would just have it re-inserted,
      // resetting its alert flags and re-firing the occurred alert.
      const expressRow = openEvents.find(
        (e) =>
          e.id !== span.id &&
          e.source === "history" &&
          e.downtime_type === type &&
          (startsMatch(e.start_epoch, span.start) ||
            (spanReason && e.reason === spanReason)) &&
          windowsOverlap(e.start_epoch, e.end_epoch, span.start, null),
      );
      if (expressRow) {
        if (existing && existing.id !== expressRow.id) liveDuplicate = existing;
        existing = expressRow;
        adopting = true;
      } else if (!existing) {
        const identityMatch = openEvents.find(
          (e) => e.id !== span.id && startsMatch(e.start_epoch, span.start) && e.downtime_type === type,
        );
        if (identityMatch) {
          existing = identityMatch;
          adopting = true;
        }
      }
    }
    const liveDuration = span.duration ?? 0;

    if (existing) {
      const liveEvt = spanToEvent(span, allItems);
      const liveMetadata = (liveEvt.metadata ?? {}) as Record<string, unknown>;
      const mergedMetadata: Record<string, unknown> = {
        ...(existing.metadata ?? {}),
        ...liveMetadata,
      };
      const needsUpdate =
        adopting ||
        (!existing.category && liveEvt.category) ||
        (!existing.reason && liveEvt.reason) ||
        (!existing.downtime_type && liveEvt.downtime_type) ||
        JSON.stringify(existing.metadata) !== JSON.stringify(mergedMetadata);
      const merged: DowntimeEvent = {
        ...existing,
        span_id: span.id ?? null,
        state: span.state ?? null,
        duration_ms: liveDuration || (existing.duration_ms ?? 0),
        category: existing.category ?? liveEvt.category ?? null,
        reason: existing.reason ?? liveEvt.reason ?? null,
        downtime_type: existing.downtime_type ?? liveEvt.downtime_type ?? null,
        metadata: mergedMetadata,
      };
      if (needsUpdate) {
        const patch: Record<string, unknown> = {
          span_id: span.id ?? null,
          state: span.state ?? null,
          category: merged.category,
          reason: merged.reason,
          downtime_type: merged.downtime_type,
          duration_ms: merged.duration_ms,
          metadata: merged.metadata,
          updated_at: new Date().toISOString(),
        };
        if (liveDuplicate) {
          // Migrate alert state from the superseded live row to the express row
          // so the occurred/resolved notifications don't re-fire.
          merged.alert_sent = liveDuplicate.alert_sent ?? merged.alert_sent ?? false;
          merged.resolved_alert_sent =
            liveDuplicate.resolved_alert_sent ?? merged.resolved_alert_sent ?? false;
          merged.last_escalation_minutes =
            liveDuplicate.last_escalation_minutes ?? merged.last_escalation_minutes ?? null;
          patch.alert_sent = merged.alert_sent;
          patch.resolved_alert_sent = merged.resolved_alert_sent;
          patch.last_escalation_minutes = merged.last_escalation_minutes;
        }
        await supabase
          .from("downtime_events")
          .update(patch)
          .eq("id", existing.id);
      }
      if (liveDuplicate) {
        const { error } = await supabase
          .from("downtime_events")
          .delete()
          .eq("id", liveDuplicate.id);
        if (error) throw new Error(error.message);
      }
      liveEvents.push(merged);
      continue;
    }

    const record = spanToEvent(span, allItems);
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
    if (!(await isOfsEnabled(supabase))) {
      console.log(`[capture-downtime] ${new Date().toISOString()} skipped — OFS disabled`);
      return json({ ok: true, skipped: true, reason: "ofs_disabled" });
    }
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
