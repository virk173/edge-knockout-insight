// Per-call persistent cache. Each API call in the collection pipeline stores its
// result in localStorage under a key tied to the match id and the internal call
// key: "edge_call_{match_id}_{call_key}" (e.g. "edge_call_1565177_8").
//
// Expiry rules:
//   - Odds calls (Stake "9" / Pinnacle "9B"): 15 minutes (prices move fast).
//   - Everything else: 60 minutes.
//   - Lineups ("6"): NEVER cached — they change up to kickoff and must always be
//     re-fetched.
//
// This lets a failed call be retried in isolation without re-running the calls
// that already succeeded (they load straight from cache).

export type CacheClass = "odds" | "static" | "never";

// Internal call keys → cache class.
const ODDS_KEYS = new Set(["9", "9B"]);
const NEVER_KEYS = new Set(["6"]);

const ODDS_TTL_MS = 15 * 60 * 1000;
const STATIC_TTL_MS = 60 * 60 * 1000;

export function callCacheClass(key: string): CacheClass {
  if (NEVER_KEYS.has(key)) return "never";
  if (ODDS_KEYS.has(key)) return "odds";
  return "static";
}

export function ttlForKey(key: string): number {
  return callCacheClass(key) === "odds" ? ODDS_TTL_MS : STATIC_TTL_MS;
}

export function callCacheKey(matchId: string | number, key: string): string {
  return `edge_call_${matchId}_${key}`;
}

export interface CachedCall {
  key: string;
  label: string;
  status: string;
  data?: unknown;
  error?: string;
  fetchedAt: number;
}

/**
 * Read a cached call result. Returns null when: never-cached key, no window,
 * missing entry, malformed entry, or expired past its TTL.
 */
export function readCallCache(
  matchId: string | number,
  key: string,
): CachedCall | null {
  if (callCacheClass(key) === "never") return null;
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(callCacheKey(matchId, key));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedCall;
    if (!parsed || typeof parsed.fetchedAt !== "number") return null;
    if (Date.now() - parsed.fetchedAt > ttlForKey(key)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeCallCache(
  matchId: string | number,
  key: string,
  entry: Omit<CachedCall, "fetchedAt"> & { fetchedAt?: number },
): void {
  if (callCacheClass(key) === "never") return;
  if (typeof window === "undefined") return;
  try {
    const payload: CachedCall = {
      ...entry,
      fetchedAt: entry.fetchedAt ?? Date.now(),
    };
    window.localStorage.setItem(
      callCacheKey(matchId, key),
      JSON.stringify(payload),
    );
  } catch {
    /* quota — skip caching this call */
  }
}

/** Wipe every cached call result for a single match id. */
export function clearMatchCache(matchId: string | number): void {
  if (typeof window === "undefined") return;
  const prefix = `edge_call_${matchId}_`;
  const toRemove: string[] = [];
  for (let i = 0; i < window.localStorage.length; i++) {
    const k = window.localStorage.key(i);
    if (k && k.startsWith(prefix)) toRemove.push(k);
  }
  toRemove.forEach((k) => window.localStorage.removeItem(k));
}
