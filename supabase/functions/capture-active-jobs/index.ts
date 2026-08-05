// capture-active-jobs — server-side active job snapshot capture
//
// Runs on a schedule (via pg_cron calling this HTTP endpoint every minute)
// so a snapshot of the currently active OFS job is saved 24/7, even when no
// browser is open. Each invocation fetches /server/live/status from OFS,
// extracts the active job details (product, SKU, target, output, progress,
// crew, shift, run state), and inserts a new row into job_snapshots.
//
// When no job is active (the line is idle / between jobs), a row is still
// inserted with job_id = null so there is a continuous record of the line
// state. Data is kept permanently — no purge.
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

interface OfsCounts {
  through?: number;
  rated?: number;
  out?: number;
  "out.unadjusted"?: number;
  "rated.unadjusted"?: number;
  "out.raw"?: number;
  "through.unadjusted"?: number;
}

interface OfsJob {
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
  $order?: {
    clientId?: string;
    name?: string;
    $product?: { name?: string; description?: string; SKU?: string };
  };
}

interface OfsCrew {
  name?: string;
}

interface OfsShift {
  id?: number;
  start?: number;
  startText?: string;
  duration?: number;
  type?: string;
  $crew?: OfsCrew;
}

interface OfsRunState {
  name?: string;
  description?: string;
  color?: string;
  state?: string;
  start?: number;
  duration?: number;
}

interface OfsLiveStatus {
  timestamp?: number;
  timestampText?: string;
  workcentre?: { name?: string; title?: string; consoletimeText?: string };
  shift?: OfsShift;
  job?: OfsJob;
  runstate?: OfsRunState;
  process?: {
    throughunitpersister?: OfsProcessCounter;
    unitsout?: OfsProcessCounter;
    outunitpersister?: OfsProcessCounter;
    unitsin?: OfsProcessCounter;
    ratedunitpersister?: OfsProcessCounter;
  };
}

function getSupabase() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("Supabase env not configured");
  return createClient(url, key, { auth: { persistSession: false } });
}

// Respects the master OFS kill switch. When `ofs_enabled` is "false" the cron
// invocation short-circuits before making any request to OFS.
async function isOfsEnabled(supabase: ReturnType<typeof getSupabase>): Promise<boolean> {
  const { data } = await supabase
    .from("app_config")
    .select("value")
    .eq("key", "ofs_enabled")
    .maybeSingle();
  return data?.value?.toLowerCase() !== "false";
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

interface JobSnapshotRow {
  console_id: string;
  capture_time: string;
  job_id: number | null;
  job_start: number | null;
  job_start_text: string | null;
  duration_ms: number | null;
  quantity: number | null;
  produced: number | null;
  rated_speed: number | null;
  progress_pct: number | null;
  product_name: string | null;
  sku: string | null;
  order_name: string | null;
  order_client_id: string | null;
  run_state: string | null;
  run_state_color: string | null;
  crew_name: string | null;
  shift_name: string | null;
  shift_id: number | null;
  counts: Record<string, number> | null;
  metadata: Record<string, unknown> | null;
}

function buildSnapshot(status: OfsLiveStatus): JobSnapshotRow {
  const job = status.job;
  const shift = status.shift;
  const runstate = status.runstate;
  const captureTime = new Date().toISOString();

  const out = job?.counts?.out ?? 0;
  const qty = job?.quantity ?? 0;
  const ratedSpeed = job?.metadata?.ratedSpeed
    ? parseInt(job.metadata.ratedSpeed, 10)
    : null;

  const progressPct = qty > 0 ? Math.round((out / qty) * 10000) / 100 : null;

  return {
    console_id: CONSOLE_ID,
    capture_time: captureTime,
    job_id: job?.id ?? null,
    job_start: job?.start ?? null,
    job_start_text: job?.startText ?? null,
    duration_ms: job?.duration ?? null,
    quantity: qty > 0 ? qty : null,
    produced: out > 0 ? out : null,
    rated_speed: ratedSpeed,
    progress_pct: progressPct,
    product_name: job?.$order?.$product?.name ?? job?.$order?.name ?? null,
    sku: job?.$order?.$product?.SKU ?? null,
    order_name: job?.$order?.name ?? null,
    order_client_id: job?.$order?.clientId ?? null,
    run_state: runstate?.name ?? runstate?.state ?? null,
    run_state_color: runstate?.color ?? null,
    crew_name: shift?.$crew?.name ?? null,
    shift_name: shift?.type ?? null,
    shift_id: shift?.id ?? null,
    counts: job?.counts ?? null,
    metadata: (job?.metadata as Record<string, unknown>) ?? null,
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
    return json({ error: "Only GET and POST is supported" }, 405);
  }
  try {
    const supabase = getSupabase();
    if (!(await isOfsEnabled(supabase))) {
      console.log(`[capture-active-jobs] ${new Date().toISOString()} skipped — OFS disabled`);
      return json({ ok: true, skipped: true, reason: "ofs_disabled" });
    }
    const status = await fetchLiveStatus();
    const snapshot = buildSnapshot(status);

    const { data, error } = await supabase
      .from("job_snapshots")
      .insert(snapshot)
      .select()
      .single();

    if (error) throw new Error(error.message);

    const hasJob = snapshot.job_id !== null;
    console.log(
      `[capture-active-jobs] ${new Date().toISOString()} job_id=${snapshot.job_id} product=${snapshot.product_name} produced=${snapshot.produced} hasJob=${hasJob}`,
    );

    return json({
      ok: true,
      snapshot: data,
      hasJob,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`[capture-active-jobs] ${new Date().toISOString()} error:`, message);
    return json({ ok: false, error: message }, 502);
  }
});
