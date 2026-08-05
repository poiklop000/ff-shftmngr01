// ofs-status v4 — events discovery + master OFS kill switch
//
// All browser-side OFS reads flow through this function, so it also enforces
// the master `ofs_enabled` flag (app_config). When the flag is "false" the
// proxy returns 503 WITHOUT contacting the OFS server — this is what makes the
// one-click kill switch stop ALL live data pulls from the phone app.
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const OFS_BASE = "https://free-flow.ofsxpress.com";
const CONSOLE = "OFS002";
const SERVER_PATH = `/OFS002/server`;

async function fetchPath(
  fullPath: string,
  auth: string,
  query?: string,
): Promise<{ status: number; body: unknown; contentType: string }> {
  const qs = query ? `?${query}` : "";
  const res = await fetch(`${OFS_BASE}${fullPath}${qs}`, {
    method: "GET",
    headers: {
      Authorization: auth,
      Accept: "application/json",
    },
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // keep raw text
  }
  return {
    status: res.status,
    body,
    contentType: res.headers.get("content-type") || "",
  };
}

// API realm: /OFS002/server/*
async function fetchApi(
  path: string,
  auth: string,
  query?: string,
): Promise<{ status: number; body: unknown }> {
  const r = await fetchPath(`${SERVER_PATH}${path}`, auth, query);
  return { status: r.status, body: r.body };
}

// Web realm: root-level /api/* and /OFS002/api/* paths protected by
// "Basic realm=OFSX Remote Access". Same credentials work for both realms.
const WEB_EVENT_CANDIDATES = [
  `api/console/${CONSOLE}/events`,
  `api/console/events`,
  `api/events`,
  `${CONSOLE}/api/events`,
  `api/console/${CONSOLE}/history`,
  `api/history`,
];

async function fetchWebEvents(
  auth: string,
  query?: string,
): Promise<{ status: number; body: unknown; path: string; attempts: { path: string; status: number; ok: boolean }[] }> {
  const attempts: { path: string; status: number; ok: boolean }[] = [];
  for (const p of WEB_EVENT_CANDIDATES) {
    const r = await fetchPath(`/${p}`, auth, query);
    const ok = r.status === 200 && r.contentType.includes("application/json");
    attempts.push({ path: `/${p}`, status: r.status, ok });
    if (ok) {
      return { status: 200, body: r.body, path: `/${p}`, attempts };
    }
  }
  // Return the last attempt's response as the best guess
  const last = attempts[attempts.length - 1];
  const lastR = await fetchPath(last.path, auth, query);
  return { status: lastR.status, body: lastR.body, path: last.path, attempts };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function getSupabase() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("Supabase env not configured");
  return createClient(url, key, { auth: { persistSession: false } });
}

async function isOfsEnabled(supabase: ReturnType<typeof getSupabase>): Promise<boolean> {
  const { data } = await supabase
    .from("app_config")
    .select("value")
    .eq("key", "ofs_enabled")
    .maybeSingle();
  return data?.value?.toLowerCase() !== "false";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  if (req.method !== "GET") {
    return json({ error: "Only GET is supported" }, 405);
  }

  try {
    const supabase = getSupabase();
    if (!(await isOfsEnabled(supabase))) {
      return json(
        { error: "OFS data collection is disabled", code: "ofs_disabled" },
        503,
      );
    }

    const user = Deno.env.get("OFS_USER");
    const pass = Deno.env.get("OFS_PASS");
    if (!user || !pass) {
      return json({ error: "OFS credentials not configured" }, 500);
    }
    const auth = `Basic ${btoa(`${user}:${pass}`)}`;

    const url = new URL(req.url);
    const endpoint = url.searchParams.get("endpoint") || "live/status";
    const debug = url.searchParams.has("debug");
    const spanStart = url.searchParams.get("start");
    const spanEnd = url.searchParams.get("end");
    const spanQuery =
      spanStart && spanEnd ? `start=${spanStart}&end=${spanEnd}` : undefined;

    // TEMPORARY diagnostic: fetch any root path with web-realm auth so we can
    // read the menu app's JS bundle and locate the real events endpoint.
    if (endpoint === "_probe") {
      const probePath = url.searchParams.get("path") || "/";
      const acceptHeader = url.searchParams.get("accept") || "*/*";
      const fullPath = probePath.startsWith("/") ? probePath : `/${probePath}`;
      const res = await fetch(`${OFS_BASE}${fullPath}`, {
        method: "GET",
        headers: { Authorization: auth, Accept: acceptHeader },
      });
      const text = await res.text();
      const respHeaders: Record<string, string> = {};
      res.headers.forEach((v, k) => { respHeaders[k] = v; });
      return json({
        status: res.status,
        contentType: res.headers.get("content-type") || "",
        length: text.length,
        headers: respHeaders,
        body: text.slice(0, 30000),
      });
    }

    // Web-realm events fetch (historical downtime by date)
    if (endpoint === "events") {
      const date = url.searchParams.get("date");
      const eventsQuery = date ? `date=${date}` : undefined;
      const r = await fetchWebEvents(auth, eventsQuery);
      if (debug) {
        return json({
          console: CONSOLE,
          endpoint: "events",
          path: r.path,
          attempts: r.attempts,
          status: r.status,
          bodyPreview: typeof r.body === "string" ? (r.body as string).slice(0, 4000) : r.body,
        });
      }
      if (r.status !== 200) {
        return json({ error: `OFS events returned ${r.status}`, path: r.path }, 502);
      }
      return json({
        console: CONSOLE,
        endpoint: "events",
        path: r.path,
        fetchedAt: new Date().toISOString(),
        data: r.body,
      });
    }

    const allowed = [
      "live/status",
      "live/process",
      "live/properties",
      "info/user",
      "live/spans",
      "data/express/spans",
      "data/express/reasontree",
      "data/summary/hour",
      "manual/crews",
      "manual/orders",
      "manual/users",
    ];
    if (!allowed.includes(endpoint)) {
      return json({ error: "Endpoint not permitted" }, 400);
    }

    // live/spans, data/summary/hour and data/express/spans accept start/end
    // query params so the client can request only the window it needs instead
    // of downloading the full span history on every load.
    const usesDateQuery =
      endpoint === "live/spans" ||
      endpoint === "data/summary/hour" ||
      endpoint === "data/express/spans";
    const result = await fetchApi(
      `/${endpoint}`,
      auth,
      usesDateQuery ? spanQuery : undefined,
    );
    if (result.status !== 200) {
      return json({ error: `OFS /${endpoint} returned ${result.status}` }, 502);
    }
    return json({
      console: CONSOLE,
      endpoint,
      fetchedAt: new Date().toISOString(),
      data: result.body,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return json({ error: message }, 502);
  }
});
