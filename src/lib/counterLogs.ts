import { fetchHourlySummary, type OfsHourSummaryItem } from '@/lib/ofs';
import type { CounterLogEntry } from '@/types';

export interface HourlySummaryEntry {
  start: number;
  hour: string;
  in: number;
  out: number;
  rated: number;
  startText: string;
}

/**
 * Fetches hourly production summary from OFS for a date range.
 * Returns entries sorted oldest-first, with In/Out/Rated counts per hour.
 */
export async function fetchHourlySummaryByDate(
  startDate: string,
  endDate?: string,
): Promise<HourlySummaryEntry[]> {
  const data = await fetchHourlySummary(startDate, endDate ?? startDate);
  const items = (data.items ?? []).slice().sort((a, b) => a.start - b.start);

  return items.map((item) => {
    const counts = extractCounts(item);
    const hourLabel = item.startText?.slice(11, 16) ?? '--:--';
    return {
      start: item.start,
      hour: hourLabel,
      in: counts.through,
      out: counts.out,
      rated: counts.rated,
      startText: item.startText ?? '',
    };
  });
}

function extractCounts(item: OfsHourSummaryItem): { through: number; out: number; rated: number } {
  const summaries = item.spanSummaries;
  if (!summaries) return { through: 0, out: 0, rated: 0 };
  const primary = summaries.inhibitOff ?? summaries.console ?? summaries.jobNotEndable;
  if (!primary?.counts) return { through: 0, out: 0, rated: 0 };
  return {
    through: primary.counts.through?.units ?? 0,
    out: primary.counts.out?.units ?? 0,
    rated: primary.counts.rated?.units ?? 0,
  };
}

/**
 * Fetches hourly summary and returns it in the CounterLogEntry format
 * so computeHourlyOutputs can consume it. The "counter" field is the
 * per-hour throughput (units produced during that hour), and "time" is
 * the hour label (HH:MM). OFS reports throughput for the hour STARTING
 * at the timestamp, so the 06:00 reading is the output for 06:00-07:00.
 */
export async function fetchCounterLogsByDate(date: string): Promise<CounterLogEntry[]> {
  const entries = await fetchHourlySummaryByDate(date);
  return entries.map((e) => ({
    time: e.hour,
    counter: e.in,
    startText: e.startText,
  }));
}
