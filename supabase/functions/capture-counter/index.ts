// capture-counter — server-side production counter capture
//
// Runs on a schedule (via pg_cron calling this HTTP endpoint every minute)
// so counter readings are captured 24/7 even when no browser is open.
// At 24,000 cans/hour (400/min, ~6.7/sec) a single 60-second poll gap can
// miss up to ~400 cans at a job changeover before the counter resets, so
// each invocation performs TWO captures 30 seconds apart, yielding an
// effective 30-second polling interval.
// Replicates the browser-based useAutoCapture logic:
//   1. Hourly capture — at the top of each hour, records the cumulative
//      filler counter using the OFS console clock.
//   2. Job-end capture — when the active job ID changes, records the last
//      known counter from the previous job before the counter resets.
//
// State (last job id, last counter, last captured hour) is persisted in the
// counter_capture_state table because edge function instances are stateless.
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const OFS_BASE = "https://free-flow.ofsxpress.com";
const SERVER_PATH = `/OFS002/server`;
const CONSOLE_ID = "OFS002";

interface OfsProcessCounter {
  rate?: number;
  value?: number;
}

interface OfsWorkcentre {
  consoletimeText?: string;
  consoletimezone?: string;
}

interface OfsJob {
  id?: number;
}

interface OfsLiveStatus {
  workcentre?: OfsWorkcentre;
  job?: OfsJob;
  process?: {
    unitsin?: OfsProcessCounter;
  };
}

interface CaptureState {
  id: number;
  console_id: string;
  last_job_id: number | null;
  last_counter: number | null;
  last_captured_hour: string | null;
}

interface CounterLogRow {
  id?: string;
  console_id: string;
  capture_date: string;
  capture_time: string;
  counter: number;
  job_id: number | null;
  capture_type: string;
  console_time: string | null;
}

function getSupabase() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("Supabase env not configured");
  return createClient(url, key, { auth: { persistSession: false } });
}

async function fetchLiveStatus(): Promise<OfsLiveStatus> {
  const user = Deno.env.get("OFS_USER");
  const pass = Deno.env.get("OFS_PASS");
  if (!user || !pass) throw new Error("OFS credentials not configured");
  const auth = `Basic ${btoa(`${user}:${pass}`)}`;
  const res = await fetch(`${OFS_BASE}${SERVER_PATH}/live/status`, {
    method: "GET",
    headers: { Authorization: auth, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`OFS live/status returned ${res.status}`);
  return (await res.json()) as OfsLiveStatus;
}

function parseConsoleTime(text: string | undefined): {
  dateStr: string;
  hourLabel: string;
  timeLabel: string;
  hours: number;
  minutes: number;
  seconds: number;
} | null {
  if (!text) return null;
  // OFS console time format: "2026-07-26 21:13:11.234"
  const match = text.match(/(\d{4}-\d{2}-\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (!match) return null;
  const [, dateStr, hh, mm, ss] = match;
  const hours = parseInt(hh, 10);
  const minutes = parseInt(mm, 10);
  const seconds = parseInt(ss, 10);
  return {
    dateStr,
    hourLabel: `${hh}:00`,
    timeLabel: `${hh}:${mm}`,
    hours,
    minutes,
    seconds,
  };
}

type CaptureAction = "hourly" | "job_end" | "none";

async function captureOnce(supabase: ReturnType<typeof getSupabase>): Promise<{
  action: CaptureAction;
  log: CounterLogRow | null;
  counter: number | null;
}> {
  const status = await fetchLiveStatus();
  const consoleTimeText = status.workcentre?.consoletimeText;
  const parsed = parseConsoleTime(consoleTimeText);
  if (!parsed) return { action: "none", log: null, counter: null };

  const counter = status.process?.unitsin?.value;
  if (counter === undefined || counter === null) {
    return { action: "none", log: null, counter: null };
  }

  const currentJobId = status.job?.id ?? null;

  // Load persisted state
  const { data: stateRows } = await supabase
    .from("counter_capture_state")
    .select("*")
    .eq("id", 1)
    .maybeSingle();
  const state = stateRows as unknown as CaptureState | null;

  const lastJobId = state?.last_job_id ?? null;
  const lastCounter = state?.last_counter ?? null;
  const lastCapturedHour = state?.last_captured_hour ?? null;

  const logs: CounterLogRow[] = [];
  let action: CaptureAction = "none";

  // 1. Job-end capture: job changed or disappeared — log the last known counter
  if (
    lastJobId !== null &&
    currentJobId !== lastJobId &&
    lastCounter !== null
  ) {
    logs.push({
      console_id: CONSOLE_ID,
      capture_date: parsed.dateStr,
      capture_time: parsed.timeLabel,
      counter: lastCounter,
      job_id: lastJobId,
      capture_type: "job_end",
      console_time: consoleTimeText ?? null,
    });
    action = "job_end";
  }

  // 2. Hourly capture at the top of each hour (first 90 seconds)
  const inCaptureWindow = parsed.minutes === 0 && parsed.seconds <= 90;
  if (inCaptureWindow && lastCapturedHour !== parsed.hourLabel) {
    logs.push({
      console_id: CONSOLE_ID,
      capture_date: parsed.dateStr,
      capture_time: parsed.hourLabel,
      counter,
      job_id: currentJobId,
      capture_type: "hourly",
      console_time: consoleTimeText ?? null,
    });
    if (action === "none") action = "hourly";
  }

  // Write any captured logs (upsert by unique constraint)
  let lastLog: CounterLogRow | null = null;
  for (const log of logs) {
    const { data, error } = await supabase
      .from("counter_logs")
      .upsert(log, { onConflict: "console_id,capture_date,capture_time" })
      .select()
      .maybeSingle();
    if (!error && data) {
      lastLog = data as unknown as CounterLogRow;
    }
  }

  // Persist updated state
  const newLastCapturedHour =
    inCaptureWindow ? parsed.hourLabel :
    (parsed.minutes !== 0 ? null : lastCapturedHour);

  await supabase
    .from("counter_capture_state")
    .upsert({
      id: 1,
      console_id: CONSOLE_ID,
      last_job_id: currentJobId,
      last_counter: counter,
      last_captured_hour: newLastCapturedHour,
      updated_at: new Date().toISOString(),
    });

  return { action, log: lastLog, counter };
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
    const startTs = new Date().toISOString();

    // First capture (beginning of the minute).
    const first = await captureOnce(supabase);
    console.log(
      `[capture-counter] ${new Date().toISOString()} pass=1 action=${first.action} counter=${first.counter}`,
    );

    // Second capture 30 seconds later for an effective 30-second polling
    // interval. At 24,000 cans/hr this halves the worst-case gap a job
    // changeover could lose from ~400 cans to ~200.
    const sleepMs = 30_000;
    await new Promise((resolve) => setTimeout(resolve, sleepMs));

    const second = await captureOnce(supabase);
    console.log(
      `[capture-counter] ${new Date().toISOString()} pass=2 action=${second.action} counter=${second.counter}`,
    );

    return json({
      ok: true,
      action: second.action,
      counter: second.counter,
      passes: [
        { action: first.action, counter: first.counter },
        { action: second.action, counter: second.counter },
      ],
      intervalMs: sleepMs,
      startedAt: startTs,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`[capture-counter] error:`, message);
    return json({ ok: false, error: message }, 502);
  }
});
