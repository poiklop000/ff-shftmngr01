// ai-summarize — Proxies a production-data summary request to Google Gemini.
//
// The frontend pre-aggregates analytics data (jobs, downtime, hourly production)
// into a compact stats payload and POSTs it here. This function builds a
// natural-language prompt, calls the Gemini free-tier API, and returns the
// generated summary text.
//
// Requires the GEMINI_API_KEY secret to be set in Supabase:
//   supabase secrets set GEMINI_API_KEY=<your-key> --project-ref zdgbhqhwhudrqcvwbytj

import { createClient } from "npm:@supabase/supabase-js@2";

const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function jsonResp(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

interface JobStat {
  jobId: number;
  product: string;
  ratedSpeed: number;
  target: number;
  produced: number;
  progressPct: number;
}

interface DowntimeTypeStat {
  type: string;
  ms: number;
  count: number;
}

interface DowntimeCategoryStat {
  category: string;
  ms: number;
  count: number;
}

interface HourlyProd {
  hour: string;
  in: number;
  out: number;
  rated: number;
}

interface DowntimeEventComment {
  author: string;
  text: string;
}

interface TopDowntimeEvent {
  durationMs: number;
  type: string;
  category: string;
  reason: string;
  comments: DowntimeEventComment[];
}

interface StatsPayload {
  mode: "brief" | "detailed";
  rangeStart: string;
  rangeEnd: string;
  totalDowntimeMs: number;
  downtimeCount: number;
  longestDowntimeMs: number;
  uptimePct: number;
  totalOut: number;
  avgEfficiency: number;
  jobs: JobStat[];
  downtimeByType: DowntimeTypeStat[];
  downtimeByCategory: DowntimeCategoryStat[];
  hourlyProduction: HourlyProd[];
  topDowntimeEvents: TopDowntimeEvent[];
}

function fmtDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function buildPrompt(s: StatsPayload): string {
  const parts: string[] = [];

  parts.push(
    "You are a factory production analyst for a canning line in New Zealand.",
  );
  parts.push(
    "Write a concise, professional summary of the production data below.",
  );
  parts.push("");

  if (s.mode === "brief") {
    parts.push(
      "Format: 2-3 short paragraphs covering: (1) key output and efficiency stats, (2) the biggest downtime issues and their root causes, (3) one notable pattern or concern.",
    );
    parts.push(
      "Use plain English with no bullet points. Keep it under 150 words.",
    );
  } else {
    parts.push("Format: a structured report with these sections:");
    parts.push("1. Overview — total output, efficiency, uptime.");
    parts.push("2. Jobs — per-job performance vs target.");
    parts.push(
      "3. Downtime Analysis — breakdown by type and top categories with root-cause observations.",
    );
    parts.push(
      "4. Hourly Trends — patterns in production throughput across shifts or days.",
    );
    parts.push(
      "5. Recommendations — 2-3 actionable suggestions to improve output or reduce downtime.",
    );
    parts.push("");
  }

  parts.push(`Date range: ${s.rangeStart} to ${s.rangeEnd}`);
  parts.push("");

  parts.push("## Key Metrics");
  parts.push(`Total output: ${s.totalOut.toLocaleString()} units`);
  parts.push(`Average efficiency: ${s.avgEfficiency.toFixed(1)}%`);
  parts.push(`Uptime: ${s.uptimePct.toFixed(1)}%`);
  parts.push(
    `Total downtime: ${fmtDuration(s.totalDowntimeMs)} across ${s.downtimeCount} events`,
  );
  parts.push(`Longest single downtime: ${fmtDuration(s.longestDowntimeMs)}`);
  parts.push(`Distinct jobs: ${s.jobs.length}`);
  parts.push("");

  if (s.jobs.length > 0) {
    parts.push("## Jobs");
    for (const j of s.jobs) {
      parts.push(
        `Job ${j.jobId} (${j.product}): ${j.produced.toLocaleString()} / ${j.target.toLocaleString()} (${j.progressPct.toFixed(0)}%) at rated ${j.ratedSpeed.toLocaleString()}/hr`,
      );
    }
    parts.push("");
  }

  if (s.downtimeByType.length > 0) {
    parts.push("## Downtime by Type");
    for (const d of s.downtimeByType) {
      parts.push(`${d.type}: ${fmtDuration(d.ms)} (${d.count} events)`);
    }
    parts.push("");
  }

  if (s.downtimeByCategory.length > 0) {
    parts.push("## Top Downtime Categories");
    const sorted = [...s.downtimeByCategory]
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 8);
    for (const c of sorted) {
      parts.push(`${c.category}: ${fmtDuration(c.ms)} (${c.count} events)`);
    }
    parts.push("");
  }

  if (s.hourlyProduction.length > 0) {
    parts.push("## Hourly Production");
    if (s.hourlyProduction.length <= 24) {
      for (const h of s.hourlyProduction) {
        const eff =
          h.rated > 0 ? ((h.in / h.rated) * 100).toFixed(0) : "-";
        parts.push(`${h.hour}: ${h.in.toLocaleString()} units (eff ${eff}%)`);
      }
    } else {
      const byDay = new Map<
        string,
        { totalIn: number; totalRated: number; hours: number }
      >();
      for (const h of s.hourlyProduction) {
        const day = h.hour.slice(0, 10);
        const entry = byDay.get(day) ?? {
          totalIn: 0,
          totalRated: 0,
          hours: 0,
        };
        entry.totalIn += h.in;
        entry.totalRated += h.rated;
        entry.hours += 1;
        byDay.set(day, entry);
      }
      for (const [day, d] of byDay) {
        const eff =
          d.totalRated > 0
            ? ((d.totalIn / d.totalRated) * 100).toFixed(0)
            : "-";
        parts.push(
          `${day}: ${d.totalIn.toLocaleString()} units over ${d.hours}h (eff ${eff}%)`,
        );
      }
    }
    parts.push("");
  }

  if (s.topDowntimeEvents.length > 0) {
    parts.push("## Top Downtime Events (with operator comments)");
    for (const e of s.topDowntimeEvents) {
      parts.push(
        `- ${fmtDuration(e.durationMs)} ${e.type} [${e.category}] reason: ${e.reason || "N/A"}`,
      );
      if (e.comments.length > 0) {
        for (const c of e.comments) {
          parts.push(`  Comment (${c.author}): "${c.text}"`);
        }
      }
    }
    parts.push("");
  }

  return parts.join("\n");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      {
        auth: { persistSession: false },
        global: { headers: { "X-Client-Info": "ai-summarize" } },
      },
    );

    // Verify the caller is authenticated
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return jsonResp({ error: "Missing authorization header" }, 401);
    }
    const token = authHeader.replace("Bearer ", "");
    const {
      data: { user },
      error: authErr,
    } = await supabase.auth.getUser(token);
    if (authErr || !user) {
      return jsonResp({ error: "Unauthorized" }, 401);
    }

    const geminiKey = Deno.env.get("GEMINI_API_KEY");
    if (!geminiKey) {
      return jsonResp(
        { error: "GEMINI_API_KEY secret not configured on the server" },
        500,
      );
    }

    const payload: StatsPayload = await req.json();
    const prompt = buildPrompt(payload);

    const geminiResp = await fetch(`${GEMINI_URL}?key=${geminiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.4,
        },
      }),
    });

    if (!geminiResp.ok) {
      const errBody = await geminiResp.text();
      console.error("Gemini API error:", geminiResp.status, errBody);
      return jsonResp(
        { error: `Gemini API returned ${geminiResp.status}` },
        502,
      );
    }

    const geminiData = await geminiResp.json();
    const text =
      geminiData?.candidates?.[0]?.content?.parts?.[0]?.text ?? null;

    if (!text) {
      return jsonResp(
        { error: "Gemini returned an empty response" },
        502,
      );
    }

    return jsonResp({ summary: text });
  } catch (err) {
    console.error("ai-summarize error:", err);
    return jsonResp(
      { error: err instanceof Error ? err.message : "Internal error" },
      500,
    );
  }
});
