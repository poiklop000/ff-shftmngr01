import { supabase } from '@/lib/supabase';

const FUNCTIONS_BASE = import.meta.env.VITE_SUPABASE_URL + '/functions/v1';
const GEMINI_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent';

// Local dev calls Gemini directly from the browser (no edge function needed).
const IS_LOCAL =
  typeof window !== 'undefined' &&
  (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');

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

export interface AiSummaryPayload {
  mode: 'brief' | 'detailed';
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

function buildPrompt(s: AiSummaryPayload): string {
  const parts: string[] = [];
  parts.push(
    'You are a factory production analyst for a canning line in New Zealand.',
  );
  parts.push(
    'Write a concise, professional summary of the production data below.',
  );
  parts.push('');

  if (s.mode === 'brief') {
    parts.push(
      'Format: 3-5 paragraphs covering: (1) key output and efficiency stats, (2) the biggest downtime issues, their root causes, and what operators said in comments, (3) per-shift or per-day patterns, (4) notable concerns or standout hours, (5) one actionable recommendation.',
    );
    parts.push(
      'Use plain English with no bullet points. Be specific with numbers. Aim for 200-300 words.',
    );
  } else {
    parts.push('Format: a structured report with these sections:');
    parts.push('1. Overview — total output, efficiency, uptime.');
    parts.push('2. Jobs — per-job performance vs target.');
    parts.push(
      '3. Downtime Analysis — breakdown by type and top categories with root-cause observations.',
    );
    parts.push(
      '4. Hourly Trends — patterns in production throughput across shifts or days.',
    );
    parts.push(
      '5. Recommendations — 2-3 actionable suggestions to improve output or reduce downtime.',
    );
    parts.push('');
  }

  parts.push(`Date range: ${s.rangeStart} to ${s.rangeEnd}`);
  parts.push('');

  parts.push('## Key Metrics');
  parts.push(`Total output: ${s.totalOut.toLocaleString()} units`);
  parts.push(`Average efficiency: ${s.avgEfficiency.toFixed(1)}%`);
  parts.push(`Uptime: ${s.uptimePct.toFixed(1)}%`);
  parts.push(
    `Total downtime: ${fmtDuration(s.totalDowntimeMs)} across ${s.downtimeCount} events`,
  );
  parts.push(`Longest single downtime: ${fmtDuration(s.longestDowntimeMs)}`);
  parts.push(`Distinct jobs: ${s.jobs.length}`);
  parts.push('');

  if (s.jobs.length > 0) {
    parts.push('## Jobs');
    for (const j of s.jobs) {
      parts.push(
        `Job ${j.jobId} (${j.product}): ${j.produced.toLocaleString()} / ${j.target.toLocaleString()} (${j.progressPct.toFixed(0)}%) at rated ${j.ratedSpeed.toLocaleString()}/hr`,
      );
    }
    parts.push('');
  }

  if (s.downtimeByType.length > 0) {
    parts.push('## Downtime by Type');
    for (const d of s.downtimeByType) {
      parts.push(`${d.type}: ${fmtDuration(d.ms)} (${d.count} events)`);
    }
    parts.push('');
  }

  if (s.downtimeByCategory.length > 0) {
    parts.push('## Top Downtime Categories');
    const sorted = [...s.downtimeByCategory]
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 8);
    for (const c of sorted) {
      parts.push(`${c.category}: ${fmtDuration(c.ms)} (${c.count} events)`);
    }
    parts.push('');
  }

  if (s.hourlyProduction.length > 0) {
    parts.push('## Hourly Production');
    if (s.hourlyProduction.length <= 24) {
      for (const h of s.hourlyProduction) {
        const eff =
          h.rated > 0 ? ((h.in / h.rated) * 100).toFixed(0) : '-';
        parts.push(
          `${h.hour}: ${h.in.toLocaleString()} units (eff ${eff}%)`,
        );
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
            : '-';
        parts.push(
          `${day}: ${d.totalIn.toLocaleString()} units over ${d.hours}h (eff ${eff}%)`,
        );
      }
    }
    parts.push('');
  }

  if (s.topDowntimeEvents.length > 0) {
    parts.push('## Top Downtime Events (with operator comments)');
    for (const e of s.topDowntimeEvents) {
      parts.push(
        `- ${fmtDuration(e.durationMs)} ${e.type} [${e.category}] reason: ${e.reason || 'N/A'}`,
      );
      if (e.comments.length > 0) {
        for (const c of e.comments) {
          parts.push(`  Comment (${c.author}): "${c.text}"`);
        }
      }
    }
    parts.push('');
  }

  return parts.join('\n');
}

async function callGeminiDirect(prompt: string, mode: string): Promise<string> {
  const key = import.meta.env.VITE_GEMINI_API_KEY;
  if (!key) {
    throw new Error(
      'VITE_GEMINI_API_KEY not set in .env — add it for local testing.',
    );
  }

  const res = await fetch(`${GEMINI_URL}?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.4,
      },
    }),
  });

  if (res.status === 429) {
    throw new Error('Rate limited — wait 60 seconds before trying again.');
  }

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${errBody}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
  if (!text) throw new Error('Gemini returned an empty response');
  return text;
}

async function callEdgeFunction(
  payload: AiSummaryPayload,
): Promise<string> {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) throw new Error('Not authenticated');

  const res = await fetch(`${FUNCTIONS_BASE}/ai-summarize`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (res.status === 429) {
    throw new Error('Rate limited — wait 60 seconds before trying again.');
  }

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `AI summary failed (${res.status})`);
  }

  const body = await res.json();
  return body.summary as string;
}

export async function fetchAiSummary(
  payload: AiSummaryPayload,
): Promise<string> {
  if (IS_LOCAL) {
    // Local dev: call Gemini directly, no edge function needed
    const prompt = buildPrompt(payload);
    return callGeminiDirect(prompt, payload.mode);
  }
  // Production: use the edge function (API key stays server-side)
  return callEdgeFunction(payload);
}
