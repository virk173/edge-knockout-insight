// Shared API-Football call counter, persisted daily in localStorage.

export const DAILY_LIMIT = 100;
export const WARNING_THRESHOLD = 85;

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
