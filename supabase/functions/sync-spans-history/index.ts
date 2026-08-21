// sync-spans-history — backfill and sync full downtime event history from OFS
//
// Fetches the complete span history from `/server/data/express/spans` which
// contains every downtime event (resolved and ongoing) with rich metadata:
// crew, job, shift, user, comments, reason category, etc.
//
// ALSO fetches `/server/live/spans` to capture setup/changeover and
// running-slow spans, which are NOT included in the express/spans endpoint.
// Setup spans are identified by a state containing "setup", running-slow by a
// state containing "slow". Active spans are upserted as ongoing events; when a
// span disappears from the live feed, the corresponding DB row is marked
// resolved. Running-slow is short-lived (typically 3-5 min), so this 5-minute
// sync is a fallback — the per-minute capture-downtime function is the primary
// source for running-slow events.
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

// Respects the master OFS kill switch. When `ofs_enabled` is "false" the sync
// short-circuits before making any request to OFS.
async function isOfsEnabled(supabase: ReturnType<typeof getSupabase>): Promise<boolean> {
  const { data } = await supabase
    .from("app_config")
    .select("value")
    .eq("key", "ofs_enabled")
    .maybeSingle();
  return data?.value?.toLowerCase() !== "false";
}

function getOfsAuth(): string {
  const user = Deno.env.get("OFS_USER");
  const pass = Deno.env.get("OFS_PASS");
  if (!user || !pass) throw new Error("OFS credentials not configured");
  return `Basic ${btoa(`${user}:${pass}`)}`;
}

// --- express/spans fetch + mapping ---

// Hourly syncs only pull a rolling window instead of the full OFS history
// (full pull is ~289KB / ~51s). 7 days keeps recent events + comments fresh
// at a fraction of the payload. Operator comments added to events older than
// the window are still visible in the app because the Analytics/Downtime
// pages read express spans live from OFS, not from this table.
const SYNC_HISTORY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

async function fetchSpansHistory(): Promise<ExpressSpan[]> {
  const auth = getOfsAuth();
  const start = Date.now() - SYNC_HISTORY_WINDOW_MS;
  const end = Date.now();
  const res = await fetch(
    `${OFS_BASE}${SERVER_PATH}/data/express/spans?start=${start}&end=${end}`,
    {
      method: "GET",
      headers: { Authorization: auth, Accept: "application/json" },
    },
  );
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

// OFS can report the same event with slightly different start epochs between
// the live feed and the express history (a few seconds to a minute of drift).
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

// Extract active setup and running-slow spans from live/spans. OFS keeps every
// span in the items array with an ever-growing duration, even after the line
// has moved on. The line can only be in one non-production state at a time, so
// only the span(s) with the latest start time are truly active.
function extractLiveSpans(spans: OfsSpansData | null): OfsLiveSpanItem[] {
  if (!spans) return [];
  const items = spans.items ?? [];
  const liveSpans = items.filter(
    (s) => s.id && s.start && ((s.state?.includes("setup") ?? false) || (s.state?.includes("slow") ?? false)),
  );
  if (liveSpans.length === 0) return [];

  // Dedupe by start + type (OFS emits overlapping spans for the same event;
  // a setup and a slow span share a start only by coincidence)
  const byStart = new Map<string, OfsLiveSpanItem>();
  for (const s of liveSpans) {
    const isSlow = s.state?.includes("slow") ?? false;
    const type = isSlow ? "RUNNING_SLOW" : "SETUP";
    const key = `${s.start}_${type}`;
    const existing = byStart.get(key);
    if (!existing) {
      byStart.set(key, s);
      continue;
    }
    // Prefer the one with a more specific state
    const existingGeneric = existing.state === "shiftStartable" || existing.state === "shiftEndable";
    const thisGeneric = s.state === "shiftStartable" || s.state === "shiftEndable";
    if (existingGeneric && !thisGeneric) byStart.set(key, s);
  }

  const deduped = [...byStart.values()];
  // Keep only the latest start — earlier spans have ended
  const latestStart = Math.max(...deduped.map((s) => s.start!));
  return deduped.filter((s) => s.start === latestStart);
}

// Enrich context for spans that carry no $reason / $crew / $user (e.g.
// running-slow and setup spans): OFS only attaches order/crew/user to the job
// (J), shift (S) and shift.job (I) spans in the same live feed, so we look up
// the latest such span that started at or before the event's start.
function contextAt(allItems: OfsLiveSpanItem[], at: number) {
  let order: NonNullable<OfsLiveSpanItem["$order"]> | null = null;
  let orderStart = -1;
  let crew: NonNullable<OfsLiveSpanItem["$crew"]> | null = null;
  let crewStart = -1;
  let user: NonNullable<OfsLiveSpanItem["$user"]> | null = null;
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

function orderLabel(order: OfsLiveSpanItem["$order"]): string | null {
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

function setupSpanToRecord(span: OfsLiveSpanItem, allItems: OfsLiveSpanItem[]) {
  const isSlow = span.state?.includes("slow") ?? false;
  const ctx = contextAt(allItems, span.start!);
  const downtimeType = isSlow ? "RUNNING_SLOW" : "SETUP";
  const reason = span.$reason?.description ?? null;
  const setupReason = reason ??
    (isSlow ? "Running Slow" : span.$order?.$product?.description ?? span.$order?.name ?? "Setup / Changeover");
  const setupCategory = span.$reason?.$category?.description ??
    span.$reason?.category?.description ??
    (isSlow ? "Running Slow" : "Setup");

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
    start_text: span.startText ?? formatEpochConsole(span.start!),
    end_epoch: null,
    duration_ms: span.duration ?? 0,
    resolved: false,
    span_class: span.class ?? null,
    span_type: span.type ?? null,
    reason_id: null,
    reason_category: null,
    reason_category_name: null,
    reason_type: downtimeType,
    crew_id: null,
    crew_name: span.$crew?.name ?? ctx.crew?.name ?? null,
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
    user_name: span.$user?.name ?? ctx.user?.name ?? null,
    comments: null,
    counts: span.counts ?? null,
    metadata: {
      crew: span.$crew?.name ?? ctx.crew?.name ?? null,
      user: span.$user?.name ?? ctx.user?.name ?? null,
      class: span.class ?? null,
      order: span.$order?.name ?? orderLabel(ctx.order ?? undefined) ?? null,
      order_client_id: ctx.order?.clientId ?? null,
      speed_pct: isSlow ? speedPct(span.counts) : null,
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
    if (!(await isOfsEnabled(supabase))) {
      console.log(`[sync-spans-history] ${new Date().toISOString()} skipped — OFS disabled`);
      return json({ ok: true, skipped: true, reason: "ofs_disabled" });
    }

    // 1. Fetch downtime history from express/spans
    const spans = await fetchSpansHistory();
    console.log(`[sync-spans-history] Fetched ${spans.length} express spans from OFS`);

    // 2. Fetch live/spans for setup and running-slow events
    const liveSpans = await fetchLiveSpans();
    const liveStateSpans = extractLiveSpans(liveSpans);
    console.log(`[sync-spans-history] Found ${liveStateSpans.length} active setup/running-slow span(s)`);

    // 3. Resolve stale live events — any open SETUP/RUNNING_SLOW event whose
    //    span ID is no longer in the live feed has ended. OFS also emits
    //    overlapping span IDs for the same event (e.g. "job.setup" ->
    //    "job.setup.running"); those are detected by event identity (start +
    //    type) and adopted below instead of being resolved and duplicated.
    const liveIds = new Set(liveStateSpans.map((s) => s.id!));
    const { data: openLiveRows } = await supabase
      .from("downtime_events")
      .select("id, start_epoch, downtime_type, reason")
      .in("downtime_type", ["SETUP", "RUNNING_SLOW"])
      .eq("resolved", false)
      .eq("user_edited", false);
    const openLive = (openLiveRows ?? []) as Array<{
      id: number;
      start_epoch: number;
      downtime_type: string | null;
      reason: string | null;
    }>;

    // User-corrected setup/slow rows are off-limits: never resolve, adopt,
    // supersede, delete, or re-upsert a span that matches one.
    const { data: editedLiveRows } = await supabase
      .from("downtime_events")
      .select("id, start_epoch, downtime_type")
      .in("downtime_type", ["SETUP", "RUNNING_SLOW"])
      .eq("user_edited", true);
    const editedLive = (editedLiveRows ?? []) as Array<{
      id: number;
      start_epoch: number;
      downtime_type: string | null;
    }>;
    const userEditedIds = new Set(editedLive.map((r) => r.id));
    const userEditedKeys = new Set(
      editedLive.map((r) => `${r.start_epoch}_${r.downtime_type}`),
    );

    const adoptedIds = new Set<number>();
    for (const s of liveStateSpans) {
      const type = s.state?.includes("slow") ? "RUNNING_SLOW" : "SETUP";
      const match = openLive.find(
        (e) => e.id !== s.id && e.start_epoch === s.start && e.downtime_type === type,
      );
      if (match) adoptedIds.add(match.id);
    }

    const staleLive = openLive.filter((e) => !liveIds.has(e.id) && !adoptedIds.has(e.id));
    const now = Date.now();
    for (const evt of staleLive) {
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
    if (staleLive.length > 0) {
      console.log(`[sync-spans-history] Resolved ${staleLive.length} stale setup/running-slow event(s)`);
    }

    // 4. Convert all spans to records
    const expressRecords = spans.map(expressSpanToRecord);
    const liveRecords = liveStateSpans.map((s) => setupSpanToRecord(s, liveSpans?.items ?? []));

    // 4b. Prefer the express (history) record over a live capture that
    //     represents the same event. capture-downtime may have written a
    //     source='live' row from the snapshot feed with a different span id and
    //     a slightly drifted start. Match on downtime type + (fuzzy start OR
    //     overlapping window with the same reason) and remove the live row so
    //     the express upsert below leaves exactly one authoritative row.
    const { data: existingLiveRows } = await supabase
      .from("downtime_events")
      .select("id, start_epoch, end_epoch, downtime_type, reason, source")
      .eq("source", "live")
      .eq("user_edited", false);
    const liveRows = (existingLiveRows ?? []) as Array<{
      id: number;
      start_epoch: number;
      end_epoch: number | null;
      downtime_type: string | null;
      reason: string | null;
    }>;
    let removedLiveDuplicates = 0;
    for (const rec of expressRecords) {
      const type = rec.downtime_type;
      if (!type) continue;
      // Only supersede a live capture once the express record is resolved.
      // While the event is still ongoing, capture-downtime is actively tracking
      // it under a live span id; deleting that row would make capture re-insert
      // it (fresh created_at + reset alert flags) and re-fire notifications.
      if (!rec.resolved) continue;
      const dup = liveRows.find(
        (l) =>
          l.id !== rec.id &&
          l.downtime_type === type &&
          (startsMatch(l.start_epoch, rec.start_epoch) ||
            (l.reason && l.reason === rec.reason &&
              windowsOverlap(l.start_epoch, l.end_epoch, rec.start_epoch, rec.end_epoch ?? null))),
      );
      if (dup) {
        const { error } = await supabase
          .from("downtime_events")
          .delete()
          .eq("id", dup.id);
        if (error) throw new Error(error.message);
        removedLiveDuplicates += 1;
      }
    }
    if (removedLiveDuplicates > 0) {
      console.log(`[sync-spans-history] Removed ${removedLiveDuplicates} live duplicate(s) superseded by express history`);
    }

    let upserted = 0;
    const BATCH_SIZE = 50;

    // Upsert live setup/slow records individually, adopting an existing open
    // row when OFS changed span ID for the same event instead of inserting a
    // duplicate. Express span IDs never collide with setup/slow IDs.
    for (const rec of liveRecords) {
      if (
        (rec.id != null && userEditedIds.has(rec.id)) ||
        userEditedKeys.has(`${rec.start_epoch}_${rec.downtime_type}`)
      ) {
        // A user corrected this event's duration/end in the app — keep it.
        continue;
      }
      const match = openLive.find(
        (e) => e.id !== rec.id && e.start_epoch === rec.start_epoch && e.downtime_type === rec.downtime_type,
      );
      if (match) {
        const patch = { ...rec };
        delete (patch as { id?: number }).id;
        // Keep an existing reason (e.g. a product name corrected via
        // job_overrides) instead of overwriting it with the raw OFS value,
        // mirroring capture-downtime's `existing.reason ?? liveEvt.reason`.
        if (match.reason) patch.reason = match.reason;
        const { data, error } = await supabase
          .from("downtime_events")
          .update(patch)
          .eq("id", match.id)
          .select("id");
        if (error) throw new Error(error.message);
        upserted += data?.length ?? 0;
      } else {
        const { data: existingRec } = await supabase
          .from("downtime_events")
          .select("reason")
          .eq("id", rec.id ?? 0)
          .maybeSingle();
        const patch = { ...rec };
        if (existingRec?.reason) delete (patch as { reason?: string | null }).reason;
        const { data, error } = await supabase
          .from("downtime_events")
          .upsert(patch, { onConflict: "id" })
          .select("id");
        if (error) {
          // Two writers inserted the same live event (same start + type) under
          // different span ids; the partial unique index on live setup/slow
          // rows made one of them fail. Adopt the winning row instead of
          // failing the whole sync.
          if (error.code === "23505" && rec.start_epoch != null && rec.downtime_type) {
            const { data: conflictRow, error: conflictErr } = await supabase
              .from("downtime_events")
              .select("id, resolved")
              .eq("console_id", CONSOLE)
              .eq("start_epoch", rec.start_epoch)
              .eq("downtime_type", rec.downtime_type)
              .eq("user_edited", false)
              .maybeSingle();
            if (conflictErr) throw new Error(conflictErr.message);
            if (conflictRow && !conflictRow.resolved) {
              const adoptPatch = { ...patch };
              delete (adoptPatch as { id?: number }).id;
              const { data: upd, error: updErr } = await supabase
                .from("downtime_events")
                .update(adoptPatch)
                .eq("id", conflictRow.id)
                .select("id");
              if (updErr) throw new Error(updErr.message);
              upserted += upd?.length ?? 0;
              continue;
            }
            // The identity is already recorded as resolved — leave it alone.
            continue;
          }
          throw new Error(error.message);
        }
        upserted += data?.length ?? 0;
      }
    }

    // Before upserting express records, build a lookup of existing rows by
    // event identity (start_epoch + downtime_type) so we can carry over alert
    // flags when OFS assigns a new span ID to the same physical event (e.g.
    // after a shift operator change). Includes recently-resolved rows because
    // staleLive above may have just resolved the old row in this sync run.
    const RECENT_RESOLVE_CUTOFF = Date.now() - 30 * 60_000;
    const { data: existingFlagRows } = await supabase
      .from("downtime_events")
      .select("id, start_epoch, downtime_type, alert_sent, resolved_alert_sent, last_escalation_minutes")
      .eq("console_id", CONSOLE)
      .or(`and(resolved.eq.false),and(resolved.eq.true,end_epoch.gte.${RECENT_RESOLVE_CUTOFF})`);
    const alertFlagLookup = new Map<string, {
      alert_sent: boolean;
      resolved_alert_sent: boolean;
      last_escalation_minutes: number | null;
    }>();
    for (const row of existingFlagRows ?? []) {
      if (!row.downtime_type) continue;
      const key = `${row.start_epoch}_${row.downtime_type}`;
      const existing = alertFlagLookup.get(key);
      if (!existing) {
        alertFlagLookup.set(key, {
          alert_sent: row.alert_sent ?? false,
          resolved_alert_sent: row.resolved_alert_sent ?? false,
          last_escalation_minutes: row.last_escalation_minutes ?? null,
        });
      } else {
        existing.alert_sent = existing.alert_sent || (row.alert_sent ?? false);
        existing.resolved_alert_sent = existing.resolved_alert_sent || (row.resolved_alert_sent ?? false);
        existing.last_escalation_minutes = Math.max(
          existing.last_escalation_minutes ?? 0,
          row.last_escalation_minutes ?? 0,
        ) || null;
      }
    }

    // Fetch IDs of existing rows so we only carry over flags for NEW rows
    const expressIds = expressRecords.map((r) => r.id).filter((id): id is number => id != null);
    const { data: existingIds } = await supabase
      .from("downtime_events")
      .select("id")
      .in("id", expressIds);
    const existingIdSet = new Set((existingIds ?? []).map((r) => r.id));

    for (let i = 0; i < expressRecords.length; i += BATCH_SIZE) {
      const batch = expressRecords.slice(i, i + BATCH_SIZE).map((rec) => {
        if (rec.id != null && !existingIdSet.has(rec.id) && rec.downtime_type) {
          const key = `${rec.start_epoch}_${rec.downtime_type}`;
          const flags = alertFlagLookup.get(key);
          if (flags && (flags.alert_sent || flags.resolved_alert_sent)) {
            return { ...rec, ...flags };
          }
        }
        return rec;
      });
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
      `[sync-spans-history] ${new Date().toISOString()} synced ${spans.length} express + ${liveStateSpans.length} live (${upserted} upserted, ${removedLiveDuplicates} live dupes removed, ${staleLive.length} resolved)`,
    );
    return json({
      ok: true,
      totalSpans: spans.length,
      liveSpans: liveStateSpans.length,
      upserted,
      removedLiveDuplicates,
      resolvedLive: staleLive.length,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`[sync-spans-history] ${new Date().toISOString()} error:`, message);
    return json({ ok: false, error: message }, 502);
  }
});
