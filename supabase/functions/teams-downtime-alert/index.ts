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

interface JobContext {
  product: string | null;
  orderName: string | null;
  ratePerHour: number | null;
}

function formatNumber(n: number): string {
  return n.toLocaleString("en-NZ");
}

// Estimated cans not produced while the line is down: duration x rated speed.
function computeCansLost(durationMs: number, ratePerHour: number): number {
  return Math.round((durationMs / 3_600_000) * ratePerHour);
}

// Find the active job snapshot captured just before the event started, so
// alerts can show which product was running and the rated line speed.
async function findJobContext(
  supabase: ReturnType<typeof getSupabase>,
  startEpoch: number,
): Promise<JobContext | null> {
  const { data } = await supabase
    .from("job_snapshots")
    .select("product_name, order_name, sku, rated_speed")
    .not("job_id", "is", null)
    .lte("capture_time", new Date(startEpoch).toISOString())
    .order("capture_time", { ascending: false })
    .limit(1);
  const row = data?.[0] as
    | { product_name?: string | null; order_name?: string | null; rated_speed?: number | null }
    | undefined;
  if (!row) return null;
  return {
    product: row.product_name ?? null,
    orderName: row.order_name ?? null,
    ratePerHour: typeof row.rated_speed === "number" ? row.rated_speed : null,
  };
}

function productFact(ctx: JobContext | null): { title: string; value: string } | null {
  if (ctx?.orderName) return { title: "Product:", value: ctx.orderName };
  if (ctx?.product) return { title: "Product:", value: ctx.product };
  return null;
}

function impactFact(durationMs: number, ctx: JobContext | null, ratePerHour: number | null): { title: string; value: string } | null {
  const rate = ctx?.ratePerHour ?? ratePerHour;
  if (!rate || rate <= 0) return null;
  return { title: "Est. cans lost:", value: formatNumber(computeCansLost(durationMs, rate)) };
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
    default:
      return { color: "Default", label: downtimeType ?? "Downtime" };
  }
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

function buildOccurredMessage(
  evt: DowntimeRow,
  ctx: JobContext | null,
  ratePerHour: number | null,
): Record<string, unknown> {
  const nowMs = Date.now();
  const durationMs = evt.duration_ms ?? (nowMs - evt.start_epoch);
  const lineName = evt.console_name ?? "Production Line";
  const style = typeStyle(evt.downtime_type);
  const reason = evt.reason ?? "No reason recorded";
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
  const impact = impactFact(durationMs, ctx, ratePerHour);
  if (impact) facts.push(impact);
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

function buildResolvedMessage(
  evt: DowntimeRow,
  ctx: JobContext | null,
  ratePerHour: number | null,
): Record<string, unknown> {
  const durationMs = evt.duration_ms ?? (evt.end_epoch ? evt.end_epoch - evt.start_epoch : 0);
  const lineName = evt.console_name ?? "Production Line";
  const style = typeStyle(evt.downtime_type);
  const reason = evt.reason ?? "No reason recorded";
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
  const impact = impactFact(durationMs, ctx, ratePerHour);
  if (impact) facts.push(impact);
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
  ratePerHour: number | null,
  thresholdMinutes: number,
): Record<string, unknown> {
  const nowMs = Date.now();
  const durationMs = evt.duration_ms ?? (nowMs - evt.start_epoch);
  const lineName = evt.console_name ?? "Production Line";
  const style = typeStyle(evt.downtime_type);
  const reason = evt.reason ?? "No reason recorded";
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
  const impact = impactFact(durationMs, ctx, ratePerHour);
  if (impact) facts.push(impact);
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
): Promise<boolean> {
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
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "<no body>");
    console.error(
      `[teams-downtime-alert] webhook POST failed: ${res.status} ${res.statusText} — ${body.slice(0, 300)}`,
    );
  }
  return res.ok;
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
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n) && n > 0);
      return levels.length > 0 ? [...levels].sort((a, b) => a - b) : [30, 60, 120];
    })();

    const { data: defaultRateRow } = await supabase
      .from("app_config")
      .select("value")
      .eq("key", "teams_default_cans_per_hour")
      .maybeSingle();
    const defaultRatePerHour = (() => {
      const n = Number(defaultRateRow?.value);
      return Number.isFinite(n) && n > 0 ? n : 24000;
    })();

    if (!webhookUrl || !enabled) {
      console.log(
        `[teams-downtime-alert] ${new Date().toISOString()} skipped — webhook: ${!!webhookUrl}, enabled: ${enabled}`,
      );
      return json({ ok: true, skipped: true, alerted: 0, webhookConfigured: !!webhookUrl, enabled });
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
      .select("id, console_name, downtime_type, reason, category, start_epoch, duration_ms, start_text, crew_name, resolved, end_epoch, alert_sent, resolved_alert_sent, last_escalation_minutes")
      .or(`and(alert_sent.eq.false,resolved.eq.false),and(alert_sent.eq.true,resolved.eq.false),and(resolved_alert_sent.eq.false,resolved.eq.true,end_epoch.gte.${recentEndCutoffMs})`)
      .order("start_epoch", { ascending: false });

    if (error) throw new Error(error.message);

    if (!events || events.length === 0) {
      console.log(`[teams-downtime-alert] ${new Date().toISOString()} no events needing alerts`);
      return json({ ok: true, alerted: 0 });
    }

    let occurredCount = 0;
    let resolvedCount = 0;
    let escalationCount = 0;
    let skippedCount = 0;
    const failed: number[] = [];

    for (const evt of events) {
      const needsOccurred = !evt.alert_sent && !evt.resolved;
      const needsResolved = !evt.resolved_alert_sent && evt.resolved;

      if (!needsOccurred && !needsResolved) {
        skippedCount++;
        continue;
      }

      // Duration check
      const effectiveDurationMs = evt.resolved
        ? (evt.duration_ms ?? (evt.end_epoch ? evt.end_epoch - evt.start_epoch : 0))
        : (nowMs - evt.start_epoch);

      // Job context (product + rated speed) + fallback can rate
      const ctx = await findJobContext(supabase, evt.start_epoch);
      const ratePerHour = ctx?.ratePerHour ?? defaultRatePerHour;

      if (needsOccurred) {
        if (effectiveDurationMs < thresholdMs) {
          skippedCount++;
          continue;
        }
        const payload = buildOccurredMessage(evt, ctx, ratePerHour);
        const sent = await sendTeams(webhookUrl, payload);
        if (sent) {
          // If the event is already past an escalation level, record the highest
          // one so a duplicate "still ongoing" alert isn't sent immediately.
          const crossed = escalationMinutes.filter((m) => effectiveDurationMs >= m * 60_000);
          const lastEscalation = crossed.length > 0 ? Math.max(...crossed) : null;
          await supabase
            .from("downtime_events")
            .update({
              alert_sent: true,
              last_escalation_minutes: lastEscalation,
              updated_at: new Date().toISOString(),
            })
            .eq("id", evt.id);
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
        const payload = buildResolvedMessage(evt, ctx, ratePerHour);
        const sent = await sendTeams(webhookUrl, payload);
        if (sent) {
          await supabase
            .from("downtime_events")
            .update({ resolved_alert_sent: true, updated_at: new Date().toISOString() })
            .eq("id", evt.id);
          resolvedCount++;
        } else {
          failed.push(evt.id);
        }
      }

      // Escalation: ongoing event that already fired its initial alert and has
      // now crossed the next escalation threshold. Only UNPLANNED downtimes
      // escalate, so routine planned/setup stops never page people.
      const isUnplanned = (evt.downtime_type ?? "").toUpperCase() === "UNPLANNED";
      if (!evt.resolved && evt.alert_sent && isUnplanned) {
        for (const m of escalationMinutes) {
          if (effectiveDurationMs >= m * 60_000 && (evt.last_escalation_minutes ?? 0) < m) {
            const payload = buildEscalationMessage(evt, ctx, ratePerHour, m);
            const sent = await sendTeams(webhookUrl, payload);
            if (sent) {
              await supabase
                .from("downtime_events")
                .update({ last_escalation_minutes: m, updated_at: new Date().toISOString() })
                .eq("id", evt.id);
              escalationCount++;
            } else {
              failed.push(evt.id);
            }
            break;
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
        .select("reason, category, console_name")
        .gte("start_epoch", oneHourAgoMs)
        .not("reason", "is", null)
        .not("category", "is", null);

      if (recentError) throw new Error(recentError.message);

      const groupMap = new Map<string, { reason: string; category: string; count: number; lines: Set<string> }>();
      for (const evt of recentEvents ?? []) {
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
        const sent = await sendTeams(webhookUrl, payload);
        if (sent) {
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
