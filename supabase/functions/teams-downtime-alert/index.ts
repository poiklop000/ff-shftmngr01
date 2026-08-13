// teams-downtime-alert — sends Microsoft Teams notifications for downtime events.
//
// Three alert types are supported:
//   1. OCCURRED — sent when an unresolved downtime has been ongoing for at least
//      the configured threshold. Tracked via the alert_sent column.
//   2. RESOLVED — sent when a downtime event ends. Tracked via the
//      resolved_alert_sent column. Only fires if the event lasted at least the
//      threshold, and includes the total duration.
//   3. RECURRING — sent when 5+ downtimes with the same reason + category occur
//      within a rolling 1-hour window. Re-fires at escalating thresholds
//      (5, 7, 9, 11, ...). Tracked via the recurring_issue_alerts table.
//
// Designed to run on a schedule (every minute via pg_cron).
import { createClient } from "npm:@supabase/supabase-js@2";

const CONSOLE_URL = "https://poiklop000.github.io/ff-shftmngr01/#/analytics";

// OFS express history is the authoritative source for the reason/category of a
// downtime span. OFS often labels a span "Unallocated" in the live feed while
// the specific reason is assigned asynchronously, so before alerting we do a
// best-effort express lookup to enrich (and verify) the freshest data. Falls
// back to the DB row untouched if OFS is unreachable.
const OFS_BASE = "https://free-flow.ofsxpress.com";
const SERVER_PATH = "/OFS002/server";

function getOfsAuth(): string | null {
  const user = Deno.env.get("OFS_USER");
  const pass = Deno.env.get("OFS_PASS");
  if (!user || !pass) return null;
  return `Basic ${btoa(`${user}:${pass}`)}`;
}

interface ExpressLookupResult {
  reason: string | null;
  category: string | null;
  resolved: boolean;
  end_epoch: number | null;
  duration_ms: number | null;
}

// Fetch express history for the window covering the candidate events and index
// it by span id. Any network/auth failure degrades to an empty map so alerts
// never block on OFS being down.
async function fetchExpressLookup(
  startMs: number,
  endMs: number,
): Promise<Map<number, ExpressLookupResult>> {
  const auth = getOfsAuth();
  if (!auth) return new Map();
  try {
    const res = await fetch(
      `${OFS_BASE}${SERVER_PATH}/data/express/spans?start=${startMs}&end=${endMs}`,
      {
        method: "GET",
        headers: { Authorization: auth, Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) {
      console.error(`[teams-downtime-alert] express lookup returned ${res.status}`);
      return new Map();
    }
    const data = (await res.json()) as {
      spans?: Array<{
        id: number;
        reasonDescription?: string | null;
        reasonCategoryName?: string | null;
        start: number;
        end?: number;
      }>;
    };
    const map = new Map<number, ExpressLookupResult>();
    for (const span of data.spans ?? []) {
      const end = span.end && span.end > 0 ? span.end : null;
      map.set(span.id, {
        reason: span.reasonDescription ?? null,
        category: span.reasonCategoryName ?? null,
        resolved: !!end,
        end_epoch: end,
        duration_ms: end ? end - span.start : null,
      });
    }
    return map;
  } catch (err) {
    console.error(
      `[teams-downtime-alert] express lookup failed: ${err instanceof Error ? err.message : err}`,
    );
    return new Map();
  }
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface DowntimeRow {
  id: number;
  console_name: string | null;
  downtime_type: string | null;
  reason: string | null;
  category: string | null;
  source: string | null;
  start_epoch: number;
  duration_ms: number | null;
  start_text: string | null;
  crew_name: string | null;
  resolved: boolean | null;
  end_epoch: number | null;
  alert_sent: boolean | null;
  resolved_alert_sent: boolean | null;
  last_escalation_minutes: number | null;
}

function getSupabase() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("Supabase env not configured");
  return createClient(url, key, { auth: { persistSession: false } });
}

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

// Format an epoch in the same local style as OFS start_text (e.g. "2026-07-28 22:14:33.581").
// OFS reports start_text in New Zealand local time with no zone suffix, so we match that
// for end times to keep the two timestamps consistent in notifications.
function formatEpochLocal(epoch: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Pacific/Auckland",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(epoch));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  const ms = String(epoch % 1000).padStart(3, "0");
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}.${ms}`;
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

// True when two rows describe the same physical downtime. OFS can surface one
// event as multiple overlapping spans — the express/history span and the
// live-feed span often carry different ids, slightly drifted starts and, until
// a user classifies the event, different types and reasons (e.g.
// UNPLANNED/Unallocated vs SETUP/Setup). Rows are the same event when their
// windows overlap AND either their starts are within a few minutes (capture /
// sync drift) or they share a specific reason (a span named once the reason is
// assigned can start well after the unclassified span it describes).
function samePhysicalEvent(a: DowntimeRow, b: DowntimeRow): boolean {
  if (!windowsOverlap(a.start_epoch, a.end_epoch, b.start_epoch, b.end_epoch)) return false;
  if (Math.abs(a.start_epoch - b.start_epoch) <= 10 * 60_000) return true;
  const aReason = a.reason && a.reason !== "Unallocated" ? a.reason : null;
  const bReason = b.reason && b.reason !== "Unallocated" ? b.reason : null;
  return !!aReason && aReason === bReason;
}

interface JobContext {
  product: string | null;
  orderName: string | null;
}

// Find the active job snapshot captured just before the event started, so
// alerts can show which product was running. A user correction (job_overrides)
// layered on the captured product name wins over the raw OFS order name.
async function findJobContext(
  supabase: ReturnType<typeof getSupabase>,
  startEpoch: number,
): Promise<JobContext | null> {
  const { data } = await supabase
    .from("job_snapshots")
    .select("job_id, product_name, order_name, sku")
    .not("job_id", "is", null)
    .lte("capture_time", new Date(startEpoch).toISOString())
    .order("capture_time", { ascending: false })
    .limit(1);
  const row = data?.[0] as
    | { job_id?: number | null; product_name?: string | null; order_name?: string | null }
    | undefined;
  if (!row) return null;

  let product: string | null = row.product_name ?? null;
  if (row.job_id != null) {
    const { data: override } = await supabase
      .from("job_overrides")
      .select("product_name")
      .eq("job_id", row.job_id)
      .maybeSingle();
    if (override?.product_name) product = override.product_name;
  }

  return {
    product,
    orderName: row.order_name ?? null,
  };
}

function productFact(ctx: JobContext | null): { title: string; value: string } | null {
  if (ctx?.product) return { title: "Product:", value: ctx.product };
  if (ctx?.orderName) return { title: "Product:", value: ctx.orderName };
  return null;
}

// Color-code alerts by downtime type so they are visually distinguishable in Teams.
//   UNPLANNED — Attention (red)   — unexpected breakdowns, highest urgency
//   PLANNED    — Accent (blue)     — scheduled maintenance / planned stops
//   SETUP      — Warning (yellow)  — product changeovers / format setups
//   default    — Default (grey)
// Resolved alerts always render in Good (green) regardless of type.
interface TypeStyle {
  color: "Attention" | "Warning" | "Accent" | "Default";
  label: string;
}

function typeStyle(downtimeType: string | null): TypeStyle {
  switch ((downtimeType ?? "").toUpperCase()) {
    case "UNPLANNED":
      return { color: "Attention", label: "Unplanned Downtime" };
    case "PLANNED":
      return { color: "Accent", label: "Planned Downtime" };
    case "SETUP":
      return { color: "Warning", label: "Setup / Changeover" };
    case "RUNNING_SLOW":
      return { color: "Accent", label: "Running Slow" };
    default:
      return { color: "Default", label: downtimeType ?? "Downtime" };
  }
}

// Running Slow is an informational condition, not a breakdown — OFS tags spans
// with downtime_type RUNNING_SLOW (reason/category "Running Slow") whenever the
// line drops below rated speed. Those get a softer "line is slow" card instead
// of being treated as unplanned downtime.
function isRunningSlow(evt: { downtime_type: string | null; reason: string | null }): boolean {
  if ((evt.downtime_type ?? "").toUpperCase() === "RUNNING_SLOW") return true;
  const reason = (evt.reason ?? "").toUpperCase();
  return reason === "RUNNING SLOW" || reason === "RUNNING_SLOW";
}

// OFS leaves a span "Unallocated" until a user classifies it, so a reason of
// "Unallocated" (or missing) is not an error — it just means no one has
// recorded a cause yet. Make that explicit on the alert so operators don't
// mistake it for a system failure.
function formatReason(reason: string | null): string {
  const r = (reason ?? "").trim();
  if (!r) return "Unallocated — reason not yet classified";
  if (r.toUpperCase() === "UNALLOCATED") return `${r} — reason not yet classified`;
  return r;
}

function buildRecurringIssueMessage(
  reason: string,
  category: string,
  count: number,
  threshold: number,
  lines: string[],
): Record<string, unknown> {
  const facts: { title: string; value: string }[] = [
    { title: "Reason:", value: reason },
    { title: "Category:", value: category },
    { title: "Occurrences (last hour):", value: String(count) },
    { title: "Alert level:", value: `${threshold} occurrences` },
  ];
  if (lines.length > 0) {
    facts.push({ title: "Lines affected:", value: lines.join(", ") });
  }

  return {
    type: "AdaptiveCard",
    version: "1.2",
    body: [
      { type: "TextBlock", text: "Recurring Issue Detected", weight: "Bolder", size: "Large", color: "Warning" },
      { type: "TextBlock", text: `The same downtime reason has occurred ${count} times in the last hour.`, wrap: true, weight: "Bolder" },
      { type: "FactSet", facts },
      { type: "TextBlock", text: "— Sent automatically by Krones Canning Line Console", wrap: true, isSubtle: true, size: "Small" },
    ],
    actions: [
      { type: "Action.OpenUrl", title: "View in Console", url: CONSOLE_URL },
    ],
  };
}

function buildTestMessage(): Record<string, unknown> {
  return {
    type: "AdaptiveCard",
    version: "1.2",
    body: [
      { type: "TextBlock", text: "Teams Alert Test", weight: "Bolder", size: "Large", color: "Good" },
      { type: "TextBlock", text: "This is a test notification from the Krones Canning Line Console. If you can read this, Teams alerts are configured correctly.", wrap: true },
      { type: "TextBlock", text: "— Sent from the console settings", wrap: true, isSubtle: true, size: "Small" },
    ],
  };
}

function buildOccurredMessage(
  evt: DowntimeRow,
  ctx: JobContext | null,
): Record<string, unknown> {
  const nowMs = Date.now();
  const durationMs = evt.duration_ms ?? (nowMs - evt.start_epoch);
  const lineName = evt.console_name ?? "Production Line";
  const style = typeStyle(evt.downtime_type);
  const reason = formatReason(evt.reason);
  const category = evt.category ?? "Uncategorised";
  const startTime = evt.start_text ?? formatEpochLocal(evt.start_epoch);

  const facts: { title: string; value: string }[] = [
    { title: "Type:", value: style.label },
    { title: "Reason:", value: reason },
    { title: "Category:", value: category },
  ];
  const product = productFact(ctx);
  if (product) facts.push(product);
  facts.push({ title: "Duration so far:", value: formatDuration(durationMs) });
  facts.push({ title: "Started:", value: startTime });
  if (evt.crew_name) facts.push({ title: "Crew:", value: evt.crew_name });

  return {
    type: "AdaptiveCard",
    version: "1.2",
    body: [
      { type: "TextBlock", text: `Downtime Started — ${lineName}`, weight: "Bolder", size: "Large", color: "Attention" },
      { type: "TextBlock", text: `${style.label} is ONGOING.`, wrap: true, color: style.color, weight: "Bolder" },
      { type: "FactSet", facts },
      { type: "TextBlock", text: "— Sent automatically by Krones Canning Line Console", wrap: true, isSubtle: true, size: "Small" },
    ],
    actions: [
      { type: "Action.OpenUrl", title: "View in Console", url: CONSOLE_URL },
    ],
  };
}

function buildRunningSlowOccurredMessage(
  evt: DowntimeRow,
  ctx: JobContext | null,
): Record<string, unknown> {
  const nowMs = Date.now();
  const durationMs = evt.duration_ms ?? (nowMs - evt.start_epoch);
  const lineName = evt.console_name ?? "Production Line";
  const startTime = evt.start_text ?? formatEpochLocal(evt.start_epoch);

  const facts: { title: string; value: string }[] = [
    { title: "Reason:", value: "Running Slow" },
  ];
  const product = productFact(ctx);
  if (product) facts.push(product);
  facts.push({ title: "Duration so far:", value: formatDuration(durationMs) });
  facts.push({ title: "Started:", value: startTime });

  return {
    type: "AdaptiveCard",
    version: "1.2",
    body: [
      { type: "TextBlock", text: `Line Running Slow — ${lineName}`, weight: "Bolder", size: "Large", color: "Warning" },
      { type: "TextBlock", text: "The line is running slow (informational).", wrap: true, weight: "Bolder" },
      { type: "FactSet", facts },
      { type: "TextBlock", text: "— Sent automatically by Krones Canning Line Console", wrap: true, isSubtle: true, size: "Small" },
    ],
    actions: [
      { type: "Action.OpenUrl", title: "View in Console", url: CONSOLE_URL },
    ],
  };
}

function buildResolvedMessage(
  evt: DowntimeRow,
  ctx: JobContext | null,
): Record<string, unknown> {
  const durationMs = evt.duration_ms ?? (evt.end_epoch ? evt.end_epoch - evt.start_epoch : 0);
  const lineName = evt.console_name ?? "Production Line";
  const style = typeStyle(evt.downtime_type);
  const reason = formatReason(evt.reason);
  const category = evt.category ?? "Uncategorised";
  const startTime = evt.start_text ?? formatEpochLocal(evt.start_epoch);
  const endTime = evt.end_epoch ? formatEpochLocal(evt.end_epoch) : "Unknown";

  const facts: { title: string; value: string }[] = [
    { title: "Type:", value: style.label },
    { title: "Reason:", value: reason },
    { title: "Category:", value: category },
  ];
  const product = productFact(ctx);
  if (product) facts.push(product);
  facts.push({ title: "Total duration:", value: formatDuration(durationMs) });
  facts.push({ title: "Started:", value: startTime });
  facts.push({ title: "Ended:", value: endTime });
  if (evt.crew_name) facts.push({ title: "Crew:", value: evt.crew_name });

  return {
    type: "AdaptiveCard",
    version: "1.2",
    body: [
      { type: "TextBlock", text: `Downtime Resolved — ${lineName}`, weight: "Bolder", size: "Large", color: "Good" },
      { type: "TextBlock", text: `${style.label} has ENDED.`, wrap: true, color: style.color, weight: "Bolder" },
      { type: "FactSet", facts },
      { type: "TextBlock", text: "— Sent automatically by Krones Canning Line Console", wrap: true, isSubtle: true, size: "Small" },
    ],
    actions: [
      { type: "Action.OpenUrl", title: "View in Console", url: CONSOLE_URL },
    ],
  };
}

function buildEscalationMessage(
  evt: DowntimeRow,
  ctx: JobContext | null,
  thresholdMinutes: number,
): Record<string, unknown> {
  const nowMs = Date.now();
  const durationMs = evt.duration_ms ?? (nowMs - evt.start_epoch);
  const lineName = evt.console_name ?? "Production Line";
  const style = typeStyle(evt.downtime_type);
  const reason = formatReason(evt.reason);
  const category = evt.category ?? "Uncategorised";
  const startTime = evt.start_text ?? formatEpochLocal(evt.start_epoch);

  const facts: { title: string; value: string }[] = [
    { title: "Type:", value: style.label },
    { title: "Reason:", value: reason },
    { title: "Category:", value: category },
  ];
  const product = productFact(ctx);
  if (product) facts.push(product);
  facts.push({ title: "Duration so far:", value: formatDuration(durationMs) });
  facts.push({ title: "Started:", value: startTime });
  if (evt.crew_name) facts.push({ title: "Crew:", value: evt.crew_name });

  return {
    type: "AdaptiveCard",
    version: "1.2",
    body: [
      { type: "TextBlock", text: `Downtime Still Ongoing — ${lineName}`, weight: "Bolder", size: "Large", color: "Attention" },
      { type: "TextBlock", text: `${style.label} has now exceeded ${thresholdMinutes} minutes.`, wrap: true, color: style.color, weight: "Bolder" },
      { type: "FactSet", facts },
      { type: "TextBlock", text: "— Sent automatically by Krones Canning Line Console", wrap: true, isSubtle: true, size: "Small" },
    ],
    actions: [
      { type: "Action.OpenUrl", title: "View in Console", url: CONSOLE_URL },
    ],
  };
}

async function sendTeams(
  webhookUrl: string,
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; httpStatus: number | null }> {
  // The Teams "Send webhook alerts to a channel" workflow expects a message
  // envelope with the AdaptiveCard attached, not the bare card.
  const body = {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: payload,
      },
    ],
  };
  let res: Response;
  try {
    res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error(
      `[teams-downtime-alert] webhook POST threw: ${err instanceof Error ? err.message : err}`,
    );
    return { ok: false, httpStatus: null };
  }
  if (!res.ok) {
    const respBody = await res.text().catch(() => "<no body>");
    console.error(
      `[teams-downtime-alert] webhook POST failed: ${res.status} ${res.statusText} — ${respBody.slice(0, 300)}`,
    );
  }
  return { ok: res.ok, httpStatus: res.status };
}

// Record every Teams notification (sent or failed) so the web app can show an
// alert history. Runs with the service role, which bypasses RLS.
interface AlertLogInput {
  alertType: string;
  eventId?: number | null;
  reason: string | null;
  category: string | null;
  product: string | null;
  message: string;
  status: string;
  httpStatus: number | null;
}

async function logAlert(
  supabase: ReturnType<typeof getSupabase>,
  input: AlertLogInput,
): Promise<void> {
  const { error } = await supabase.from("alert_log").insert({
    alert_type: input.alertType,
    event_id: input.eventId ?? null,
    reason: input.reason,
    category: input.category,
    product: input.product,
    message: input.message,
    status: input.status,
    http_status: input.httpStatus,
  });
  if (error) {
    console.error(`[teams-downtime-alert] alert_log insert failed: ${error.message}`);
  }
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

    const { data: cfgRow } = await supabase
      .from("app_config")
      .select("value")
      .eq("key", "teams_webhook_url")
      .maybeSingle();
    const webhookUrl = cfgRow?.value?.trim();

    const { data: enabledRow } = await supabase
      .from("app_config")
      .select("value")
      .eq("key", "teams_alerts_enabled")
      .maybeSingle();
    const enabled = enabledRow?.value?.toLowerCase() === "true";

    const { data: thresholdRow } = await supabase
      .from("app_config")
      .select("value")
      .eq("key", "teams_alert_threshold_minutes")
      .maybeSingle();
    const thresholdMinutes = Number(thresholdRow?.value);
    const thresholdMs = (Number.isFinite(thresholdMinutes) && thresholdMinutes >= 0
      ? thresholdMinutes
      : 10) * 60_000;

    const { data: recurringEnabledRow } = await supabase
      .from("app_config")
      .select("value")
      .eq("key", "teams_recurring_alerts_enabled")
      .maybeSingle();
    const recurringEnabled = recurringEnabledRow?.value?.toLowerCase() === "true";

    const { data: recurringThresholdRow } = await supabase
      .from("app_config")
      .select("value")
      .eq("key", "teams_recurring_alert_initial_threshold")
      .maybeSingle();
    const recurringInitialThreshold = (() => {
      const n = Number(recurringThresholdRow?.value);
      return Number.isFinite(n) && n >= 2 ? Math.floor(n) : 5;
    })();

    const { data: escalationRow } = await supabase
      .from("app_config")
      .select("value")
      .eq("key", "teams_alert_escalation_minutes")
      .maybeSingle();
    const escalationMinutes = (() => {
      const levels = (escalationRow?.value ?? "30,60,120")
        .split(",")
        .map((s: string) => Number(s.trim()))
        .filter((n: number) => Number.isFinite(n) && n > 0);
      return levels.length > 0 ? [...levels].sort((a, b) => a - b) : [30, 60, 120];
    })();

    if (!webhookUrl || !enabled) {
      console.log(
        `[teams-downtime-alert] ${new Date().toISOString()} skipped — webhook: ${!!webhookUrl}, enabled: ${enabled}`,
      );
      return json({ ok: true, skipped: true, alerted: 0, webhookConfigured: !!webhookUrl, enabled });
    }

    // Test mode: a client (Settings → Send Test Alert) calls with {"test": true}
    // to verify the webhook without waiting for a real downtime. Runs even if
    // alerts are disabled, as long as a webhook URL is configured. Pass an
    // optional {"reason": "..."} to preview the real occurred card with that
    // reason (defaults to the unclassified "Unallocated" case).
    let testRequested = false;
    let testReason: string | null = null;
    try {
      const body = (await req.clone().json()) as { test?: boolean; reason?: string | null };
      testRequested = body.test === true;
      testReason = body.reason ?? null;
    } catch {
      testRequested = false;
    }
    if (testRequested) {
      let payload: Record<string, unknown>;
      let testMessage = "Test Alert";
      if (testReason !== null) {
        const mockEvt: DowntimeRow = {
          id: 0,
          console_name: "Production Line 1",
          downtime_type: "UNPLANNED",
          reason: testReason,
          category: "Unallocated",
          source: "test",
          start_epoch: Date.now() - 10 * 60_000,
          duration_ms: 10 * 60_000,
          start_text: null,
          crew_name: null,
          resolved: false,
          end_epoch: null,
          alert_sent: false,
          resolved_alert_sent: false,
          last_escalation_minutes: null,
        };
        if (isRunningSlow(mockEvt)) {
          mockEvt.downtime_type = "RUNNING_SLOW";
          payload = buildRunningSlowOccurredMessage(mockEvt, null);
          testMessage = "Test Alert (Running Slow)";
        } else {
          payload = buildOccurredMessage(mockEvt, null);
          testMessage = `Test Alert (${testReason})`;
        }
      } else {
        payload = buildTestMessage();
      }
      const res = await sendTeams(webhookUrl, payload);
      await logAlert(supabase, {
        alertType: "test",
        eventId: null,
        reason: testReason,
        category: null,
        product: null,
        message: testMessage,
        status: res.ok ? "sent" : "failed",
        httpStatus: res.httpStatus,
      });
      return json({ ok: res.ok, alerted: res.ok ? 1 : 0, test: true });
    }

    const nowMs = Date.now();
    const recentEndCutoffMs = nowMs - 10 * 60_000;

    // Fetch events that need either an OCCURRED or RESOLVED alert.
    // Conditions:
    //   - OCCURRED alert needed: alert_sent = false AND unresolved AND ongoing >= threshold
    //   - RESOLVED alert needed: resolved_alert_sent = false AND resolved AND ended recently
    //     AND total duration >= threshold
    const { data: events, error } = await supabase
      .from("downtime_events")
      .select("id, console_name, downtime_type, reason, category, source, start_epoch, duration_ms, start_text, crew_name, resolved, end_epoch, alert_sent, resolved_alert_sent, last_escalation_minutes")
      .or(`and(alert_sent.eq.false,resolved.eq.false),and(alert_sent.eq.true,resolved.eq.false),and(resolved_alert_sent.eq.false,resolved.eq.true,end_epoch.gte.${recentEndCutoffMs})`)
      .order("start_epoch", { ascending: false });

    if (error) throw new Error(error.message);

    if (!events || events.length === 0) {
      console.log(`[teams-downtime-alert] ${new Date().toISOString()} no events needing alerts`);
      return json({ ok: true, alerted: 0 });
    }

    // The same physical downtime can surface as several rows: the live-feed
    // span (written by capture-downtime) and the express/history span (written
    // by sync-spans-history) can carry different span ids, slightly drifted
    // start epochs and — until an OFS user classifies the event — different
    // downtime types and reasons (e.g. UNPLANNED/Unallocated vs SETUP/Setup).
    // Alerting on every row produces duplicate alert chains, so rows that
    // describe the same physical event (overlapping windows, type-agnostic)
    // are merged into one group.
    const grouped: DowntimeRow[][] = [];
    for (const evt of events) {
      let placed = false;
      for (const rows of grouped) {
        if (rows.some((r) => samePhysicalEvent(evt, r))) {
          rows.push(evt);
          placed = true;
          break;
        }
      }
      if (!placed) grouped.push([evt]);
    }

    // The row that carries the most information (history over live, a specific
    // reason over "Unallocated", earliest start) is the "face" of the event.
    const preferredIds = new Set<number>();
    const groupMembers = new Map<number, DowntimeRow[]>();
    for (const rows of grouped) {
      rows.sort((a, b) => {
        const aHistory = a.source === "history";
        const bHistory = b.source === "history";
        if (aHistory !== bHistory) return aHistory ? -1 : 1;
        const aSpecific = a.reason && a.reason !== "Unallocated";
        const bSpecific = b.reason && b.reason !== "Unallocated";
        if (aSpecific !== bSpecific) return aSpecific ? -1 : 1;
        return a.start_epoch - b.start_epoch;
      });
      const preferred = rows[0]!;
      preferredIds.add(preferred.id);
      for (const r of rows) groupMembers.set(r.id, rows);
    }

    // Enrich candidate events with the freshest express history so the alert
    // carries the assigned reason/category and the true resolution state
    // (fixes "Unallocated" reasons and under-threshold occurred alerts).
    const earliestStart = Math.min(...events.map((e) => e.start_epoch));
    const expressLookup = await fetchExpressLookup(
      earliestStart - 5 * 60_000,
      nowMs + 60_000,
    );
    const enrichedEvents = events.map((evt) => {
      const fresh = expressLookup.get(evt.id);
      if (!fresh) return evt;
      const reason = fresh.reason && fresh.reason !== "Unallocated" ? fresh.reason : evt.reason;
      const category = fresh.category && fresh.category !== evt.category ? fresh.category : evt.category;
      if (
        reason === evt.reason &&
        category === evt.category &&
        fresh.resolved === (evt.resolved ?? false) &&
        fresh.end_epoch === evt.end_epoch
      ) {
        return evt;
      }
      return {
        ...evt,
        reason,
        category,
        resolved: evt.resolved ?? fresh.resolved,
        end_epoch: fresh.end_epoch ?? evt.end_epoch,
        duration_ms: fresh.duration_ms ?? evt.duration_ms,
      };
    });
    const enrichedById = new Map<number, DowntimeRow>(enrichedEvents.map((e) => [e.id, e] as const));

    // Merge each group into a single logical event: the face row supplies the
    // content (most specific reason wins), but alert state is the union of
    // every member — so a sibling row can't re-fire an alert the event already
    // sent — and the event counts as resolved the moment any member is resolved,
    // so a stuck ghost row stops escalating once the real span has ended.
    const logicalEvents = new Map<number, DowntimeRow>();
    for (const rows of grouped) {
      const enrichedRows = rows.map((r) => enrichedById.get(r.id) ?? r);
      const specific = enrichedRows.filter((r) => r.reason && r.reason !== "Unallocated");
      const face = specific[0]! ?? enrichedRows[0]!;
      const resolvedRows = enrichedRows.filter((r) => r.resolved);
      const logical: DowntimeRow = {
        ...face,
        alert_sent: enrichedRows.some((r) => r.alert_sent),
        resolved_alert_sent: enrichedRows.some((r) => r.resolved_alert_sent),
        last_escalation_minutes:
          enrichedRows.reduce((m, r) => Math.max(m, r.last_escalation_minutes ?? 0), 0) || null,
        resolved: face.resolved || resolvedRows.length > 0,
      };
      if (resolvedRows.length > 0) {
        const resolvedRow = resolvedRows.sort(
          (a, b) => (a.end_epoch ?? 0) - (b.end_epoch ?? 0),
        )[0]!;
        logical.end_epoch = resolvedRow.end_epoch ?? face.end_epoch;
        logical.duration_ms =
          resolvedRow.duration_ms ??
          (resolvedRow.end_epoch ? resolvedRow.end_epoch - resolvedRow.start_epoch : null);
      }
      for (const r of rows) logicalEvents.set(r.id, logical);
    }

    let occurredCount = 0;
    let resolvedCount = 0;
    let escalationCount = 0;
    let skippedCount = 0;
    const failed: number[] = [];

    for (const evt of events) {
      if (!preferredIds.has(evt.id)) {
        skippedCount++;
        continue;
      }
      // The logical event unions the alert state of every row in the group, so
      // a sibling row can't re-fire a chain the event already sent.
      const enriched = logicalEvents.get(evt.id) ?? enrichedById.get(evt.id) ?? evt;
      const members = groupMembers.get(evt.id) ?? [evt];
      const runningSlow = isRunningSlow(enriched);
      const needsOccurred = !enriched.alert_sent && !enriched.resolved;
      const needsResolved = !enriched.resolved_alert_sent && enriched.resolved;
      // An event that already fired its initial alert is still a candidate for
      // escalation while it remains unresolved — it must not be skipped here.
      const needsEscalation = !enriched.resolved && enriched.alert_sent;

      if (!needsOccurred && !needsResolved && !needsEscalation) {
        skippedCount++;
        continue;
      }

      // Duration check — use the true duration once the event has resolved,
      // otherwise elapsed time since start.
      const effectiveDurationMs = enriched.resolved
        ? (enriched.duration_ms ?? (enriched.end_epoch ? enriched.end_epoch - enriched.start_epoch : 0))
        : (nowMs - enriched.start_epoch);

      // Job context (product for the alert) 
      const ctx = await findJobContext(supabase, enriched.start_epoch);
      const product = ctx?.product ?? ctx?.orderName ?? null;

      if (needsOccurred) {
        if (effectiveDurationMs < thresholdMs) {
          skippedCount++;
          continue;
        }
        const payload = runningSlow
          ? buildRunningSlowOccurredMessage(enriched, ctx)
          : buildOccurredMessage(enriched, ctx);
        const res = await sendTeams(webhookUrl, payload);
        await logAlert(supabase, {
          alertType: runningSlow ? "running_slow" : "occurred",
          eventId: enriched.id,
          reason: enriched.reason,
          category: enriched.category,
          product,
          message: runningSlow
            ? `Line Running Slow — ${enriched.console_name ?? "Production Line"}`
            : `Downtime Started — ${enriched.console_name ?? "Production Line"}`,
          status: res.ok ? "sent" : "failed",
          httpStatus: res.httpStatus,
        });
        if (res.ok) {
          // If the event is already past an escalation level, record the highest
          // one so a duplicate "still ongoing" alert isn't sent immediately.
          const crossed = escalationMinutes.filter((m) => effectiveDurationMs >= m * 60_000);
          const lastEscalation = crossed.length > 0 ? Math.max(...crossed) : null;
          for (const m of members) {
            await supabase
              .from("downtime_events")
              .update({
                alert_sent: true,
                last_escalation_minutes: lastEscalation,
                updated_at: new Date().toISOString(),
              })
              .eq("id", m.id);
          }
          occurredCount++;
        } else {
          failed.push(evt.id);
        }
      }

      if (needsResolved) {
        if (effectiveDurationMs < thresholdMs) {
          skippedCount++;
          continue;
        }
        // Running Slow is informational only — no resolved notification. Mark
        // the flag so it isn't picked up again on the next run.
        if (runningSlow) {
          for (const m of members) {
            await supabase
              .from("downtime_events")
              .update({ resolved_alert_sent: true, updated_at: new Date().toISOString() })
              .eq("id", m.id);
          }
          continue;
        }
        const payload = buildResolvedMessage(enriched, ctx);
        const res = await sendTeams(webhookUrl, payload);
        await logAlert(supabase, {
          alertType: "resolved",
          eventId: enriched.id,
          reason: enriched.reason,
          category: enriched.category,
          product,
          message: `Downtime Resolved — ${enriched.console_name ?? "Production Line"}`,
          status: res.ok ? "sent" : "failed",
          httpStatus: res.httpStatus,
        });
        if (res.ok) {
          for (const m of members) {
            await supabase
              .from("downtime_events")
              .update({ resolved_alert_sent: true, updated_at: new Date().toISOString() })
              .eq("id", m.id);
          }
          resolvedCount++;
        } else {
          failed.push(enriched.id);
        }
      }

      // Escalation: ongoing event that already fired its initial alert and has
      // now crossed the next escalation threshold. Only UNPLANNED downtimes
      // escalate, so routine planned/setup stops and running-slow notices never
      // page people.
      const isUnplanned = (enriched.downtime_type ?? "").toUpperCase() === "UNPLANNED";
      if (!enriched.resolved && enriched.alert_sent && isUnplanned && !runningSlow) {
        // Pick the highest threshold the event has now crossed that hasn't been
        // alerted yet, so a long-running downtime jumps straight to the correct
        // level instead of replaying 30/60/120 over consecutive runs.
        const crossed = escalationMinutes.filter(
          (m) => effectiveDurationMs >= m * 60_000 && (enriched.last_escalation_minutes ?? 0) < m,
        );
        if (crossed.length > 0) {
          const m = crossed[crossed.length - 1]!;
          const payload = buildEscalationMessage(enriched, ctx, m);
          const res = await sendTeams(webhookUrl, payload);
          await logAlert(supabase, {
            alertType: "escalation",
            eventId: enriched.id,
            reason: enriched.reason,
            category: enriched.category,
            product,
            message: `Downtime Still Ongoing — ${enriched.console_name ?? "Production Line"} (${m} min)`,
            status: res.ok ? "sent" : "failed",
            httpStatus: res.httpStatus,
          });
          if (res.ok) {
            for (const mb of members) {
              await supabase
                .from("downtime_events")
                .update({ last_escalation_minutes: m, updated_at: new Date().toISOString() })
                .eq("id", mb.id);
            }
            escalationCount++;
          } else {
            failed.push(enriched.id);
          }
        }
      }
    }

    // --- Recurring issue detection ---
    // Count downtime_events from the last 60 minutes grouped by reason + category.
    // If any group reaches the escalating threshold (5, 7, 9, ...), send an alert.
    let recurringCount = 0;

    if (recurringEnabled) {
      const oneHourAgoMs = nowMs - 60 * 60 * 1000;

      const { data: recentEvents, error: recentError } = await supabase
        .from("downtime_events")
        .select("reason, category, console_name, downtime_type")
        .gte("start_epoch", oneHourAgoMs)
        .not("reason", "is", null)
        .not("category", "is", null);

      if (recentError) throw new Error(recentError.message);

      const groupMap = new Map<string, { reason: string; category: string; count: number; lines: Set<string> }>();
      for (const evt of recentEvents ?? []) {
        // Running Slow is an informational condition, not an issue — exclude it
        // so a chronically slow line doesn't flood the recurring-issue channel.
        if (isRunningSlow(evt)) continue;
        const key = `${evt.reason}|||${evt.category}`;
        const existing = groupMap.get(key);
        if (existing) {
          existing.count++;
          if (evt.console_name) existing.lines.add(evt.console_name);
        } else {
          groupMap.set(key, {
            reason: evt.reason as string,
            category: evt.category as string,
            count: 1,
            lines: new Set(evt.console_name ? [evt.console_name] : []),
          });
        }
      }

      const { data: trackingRows, error: trackingError } = await supabase
        .from("recurring_issue_alerts")
        .select("id, reason, category, last_threshold, last_alerted_at");

      if (trackingError) throw new Error(trackingError.message);

      const trackingMap = new Map<string, { id: string; last_threshold: number; last_alerted_at: string }>();
      for (const row of trackingRows ?? []) {
        trackingMap.set(`${row.reason}|||${row.category}`, {
          id: row.id as string,
          last_threshold: row.last_threshold as number,
          last_alerted_at: row.last_alerted_at as string,
        });
      }

      for (const [, group] of groupMap) {
        if (group.count < recurringInitialThreshold) continue;

        const trackingKey = `${group.reason}|||${group.category}`;
        const tracking = trackingMap.get(trackingKey);

        const trackingAgeMs = tracking
          ? nowMs - new Date(tracking.last_alerted_at).getTime()
          : Infinity;
        const isStale = trackingAgeMs > 60 * 60 * 1000;

        let nextThreshold: number;
        if (!tracking || isStale) {
          nextThreshold = recurringInitialThreshold;
        } else {
          nextThreshold = tracking.last_threshold + 2;
        }

        if (group.count < nextThreshold) continue;

        const payload = buildRecurringIssueMessage(
          group.reason,
          group.category,
          group.count,
          nextThreshold,
          Array.from(group.lines),
        );
        const res = await sendTeams(webhookUrl, payload);
        await logAlert(supabase, {
          alertType: "recurring",
          eventId: null,
          reason: group.reason,
          category: group.category,
          product: null,
          message: `Recurring Issue Detected (${group.count}× ${group.reason})`,
          status: res.ok ? "sent" : "failed",
          httpStatus: res.httpStatus,
        });
        if (res.ok) {
          const nowIso = new Date().toISOString();
          await supabase
            .from("recurring_issue_alerts")
            .upsert({
              reason: group.reason,
              category: group.category,
              last_threshold: nextThreshold,
              last_alerted_at: nowIso,
              occurrence_count: group.count,
              updated_at: nowIso,
            }, { onConflict: "reason,category" });
          recurringCount++;
        }
      }
    }

    const totalAlerted = occurredCount + resolvedCount + escalationCount + recurringCount;
    console.log(
      `[teams-downtime-alert] ${new Date().toISOString()} occurred=${occurredCount} resolved=${resolvedCount} escalation=${escalationCount} recurring=${recurringCount} skipped=${skippedCount} failed=${failed.length}`,
    );
    return json({ ok: true, alerted: totalAlerted, occurred: occurredCount, resolved: resolvedCount, escalation: escalationCount, recurring: recurringCount, skipped: skippedCount, failed });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`[teams-downtime-alert] ${new Date().toISOString()} error:`, message);
    return json({ ok: false, error: message }, 502);
  }
});
