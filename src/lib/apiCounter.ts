// Shared API-Football call counter, persisted daily in localStorage.
// The key embeds the UTC date, so the count resets automatically at midnight
// UTC (a new day produces a new key that starts at 0).

export const DAILY_LIMIT = 100;
export const AMBER_THRESHOLD = 70; // header turns amber above this
export const WARNING_THRESHOLD = 85; // skip C8 + C10; warning banner
export const CRITICAL_THRESHOLD = 95; // skip C7 + C8 + C10; critical banner

function todayKey(): string {
  return `apifootball_calls_${new Date().toISOString().slice(0, 10)}`;
}

export function getApiCallCount(): number {
  if (typeof window === "undefined") return 0;
  const raw = window.localStorage.getItem(todayKey());
  const n = raw ? parseInt(raw, 10) : 0;
  return Number.isFinite(n) ? n : 0;
}

export function incrementApiCallCount(by = 1): number {
  if (typeof window === "undefined") return 0;
  const next = getApiCallCount() + by;
  window.localStorage.setItem(todayKey(), String(next));
  return next;
}

export type BudgetLevel = "ok" | "amber" | "warning" | "critical";

// Maps a count to a budget level used for header colour + banners.
export function budgetLevel(count: number): BudgetLevel {
  if (count >= CRITICAL_THRESHOLD) return "critical";
  if (count >= WARNING_THRESHOLD) return "warning";
  if (count >= AMBER_THRESHOLD) return "amber";
  return "ok";
}
