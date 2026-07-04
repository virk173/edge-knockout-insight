/**
 * clv.ts — Closing Line Value tracking.
 *
 * Closing Line Value (CLV) is the % by which our bet price beats the final
 * pre-kickoff price. It is the fastest reliable measure of real edge —
 * statistically meaningful in ~50 bets vs 500+ for raw profit. The benchmark
 * is Pinnacle's close when available, else Stake's own close (flagged as
 * soft-book CLV, lower reliability).
 *
 * Closing captures are persisted in localStorage per match+date with a 7-day
 * TTL. All storage access is SSR-guarded.
 */

import { resolveMarketType } from "@/lib/bettingGlossary";

export type ClosingSource = "PINNACLE" | "STAKE" | "RETAIL" | "MANUAL";

export interface ClosingCapture {
  matchId: number;
  capturedAt: number; // epoch ms
  minutesBeforeKickoff: number;
  source: ClosingSource;
  // market label → array of { selection, odds }. An outcome may carry its own
  // source override (e.g. one MANUAL price merged into a PINNACLE capture);
  // absent = inherit the capture-level source. Old captures have no per-
  // outcome source and behave exactly as before.
  prices: Record<
    string,
    Array<{ selection: string; odds: number; source?: ClosingSource }>
  >;
}

const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function hasWindow(): boolean {
  return typeof window !== "undefined";
}

function ymd(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

/** localStorage key: "edge_closing_{matchId}_{YYYY-MM-DD}". */
export function closingKey(matchId: number, date: Date = new Date()): string {
  return `edge_closing_${matchId}_${ymd(date)}`;
}

/** Persist a closing capture (keyed by matchId + today). */
export function writeClosingCapture(c: ClosingCapture): void {
  if (!hasWindow()) return;
  try {
    window.localStorage.setItem(
      closingKey(c.matchId, new Date(c.capturedAt)),
      JSON.stringify(c),
    );
  } catch {
    // ignore quota / serialization failures
  }
}

/**
 * Read the most recent non-expired capture for a match. Scans the current day
 * and the previous 7 days (captures can be written the day after kickoff for
 * late-night UTC fixtures). Returns null when none found or expired.
 */
export function readClosingCapture(matchId: number): ClosingCapture | null {
  if (!hasWindow()) return null;
  const now = Date.now();
  let best: ClosingCapture | null = null;
  for (let back = 0; back <= 7; back++) {
    const d = new Date(now - back * 24 * 60 * 60 * 1000);
    const raw = window.localStorage.getItem(closingKey(matchId, d));
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as ClosingCapture;
      if (!parsed || typeof parsed.capturedAt !== "number") continue;
      if (now - parsed.capturedAt > TTL_MS) {
        // Expired — clean it up.
        window.localStorage.removeItem(closingKey(matchId, d));
        continue;
      }
      if (!best || parsed.capturedAt > best.capturedAt) best = parsed;
    } catch {
      // ignore malformed entry
    }
  }
  return best;
}

/**
 * CLV % = (betOdds / closingOdds - 1) * 100, 2dp.
 * Positive = our bet price beat the close.
 */
export function computeClv(betOdds: number, closingOdds: number): number {
  if (
    !Number.isFinite(betOdds) ||
    !Number.isFinite(closingOdds) ||
    closingOdds <= 0
  ) {
    return NaN;
  }
  return Math.round((betOdds / closingOdds - 1) * 100 * 100) / 100;
}

/**
 * Resolve the closing price for a given market + selection inside a capture.
 * Match via resolveMarketType on BOTH sides (so "Match Winner" resolves to the
 * same key as "1X2"), then case-insensitive selection substring match in both
 * directions. Returns null when unmatched — NEVER guesses a price.
 */
export function matchClosingPrice(
  capture: ClosingCapture | null | undefined,
  marketName: string,
  selection: string,
): { odds: number; source: ClosingSource } | null {
  if (!capture || !capture.prices) return null;
  const wantType = resolveMarketType(marketName ?? "");
  const sel = (selection ?? "").toLowerCase().trim();

  // Two passes: EXACT selection equality wins over substring. With multiple
  // lines of the same market captured (e.g. "France -1" AND "France -1.5"),
  // a substring-first scan can return the WRONG line's price — "france -1" is
  // a substring of "france -1.5". Exact-first prevents that; substring stays
  // as the fallback for phrasing differences ("France Win" vs "France").
  let fallback: { odds: number; source: ClosingSource } | null = null;
  for (const [capMarket, outcomes] of Object.entries(capture.prices)) {
    if (!Array.isArray(outcomes)) continue;
    // Market must resolve to the same glossary type, OR match by raw label.
    const capType = resolveMarketType(capMarket);
    const marketMatches =
      (wantType !== null && capType !== null && wantType === capType) ||
      capMarket.toLowerCase().trim() === (marketName ?? "").toLowerCase().trim();
    if (!marketMatches) continue;

    for (const o of outcomes) {
      const capSel = String(o?.selection ?? "").toLowerCase().trim();
      if (!capSel || !sel) continue;
      const odds = Number(o?.odds);
      if (!Number.isFinite(odds) || odds <= 0) continue;
      const outcomeSource = o?.source ?? capture.source;
      if (capSel === sel) {
        return { odds, source: outcomeSource };
      }
      // Case-insensitive substring match in both directions (fallback only).
      if (!fallback && (capSel.includes(sel) || sel.includes(capSel))) {
        fallback = { odds, source: outcomeSource };
      }
    }
  }
  return fallback;
}
