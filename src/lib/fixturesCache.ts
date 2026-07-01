// Date-scoped localStorage cache for the fixtures list. The list is only
// refreshed on an explicit user action; this cache lets returning users see
// their last fetched list immediately without any automatic fetch.

import type { AnalysedMatch } from "./fixtures";

export const FIXTURES_STALE_MS = 30 * 60 * 1000; // 30 minutes

export interface FixturesCache {
  fetchedAt: number; // epoch ms
  matches: AnalysedMatch[];
}

// Local YYYY-MM-DD so tomorrow's session starts fresh (won't show yesterday's
// stale list under a different key).
function todayKey(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `edge_fixtures_${y}-${m}-${day}`;
}

export function readFixturesCache(): FixturesCache | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(todayKey());
    if (!raw) return null;
    const parsed = JSON.parse(raw) as FixturesCache;
    if (
      !parsed ||
      typeof parsed.fetchedAt !== "number" ||
      !Array.isArray(parsed.matches)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function writeFixturesCache(matches: AnalysedMatch[]): FixturesCache {
  const entry: FixturesCache = { fetchedAt: Date.now(), matches };
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.setItem(todayKey(), JSON.stringify(entry));
    } catch {
      // ignore quota / serialization errors
    }
  }
  return entry;
}

export function isStale(fetchedAt: number, now: number = Date.now()): boolean {
  return now - fetchedAt > FIXTURES_STALE_MS;
}

// "Last updated: Xm ago" style relative label.
export function formatAgo(fetchedAt: number, now: number = Date.now()): string {
  const diffMs = Math.max(0, now - fetchedAt);
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins === 1) return "1m ago";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs === 1) return "1h ago";
  return `${hrs}h ago`;
}
