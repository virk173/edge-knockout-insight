// ─────────────────────────────────────────────────────────────
// Known data-source gaps
// ─────────────────────────────────────────────────────────────
// Some betting markets exist as bet-type IDs in the odds provider's catalog
// but are never populated by any bookmaker in the actual feed. These are
// PERMANENT source limitations — distinct from a transient "N/A" (an odds
// call that failed for one run). We gate the display language behind explicit
// flags so that, if a future odds source starts carrying one of these markets,
// we flip a single constant instead of hunting display strings across the app.

// CARDS / BOOKINGS
// 2026-07-02: verified live against 3 real WC2026 fixtures — API-Football's
// /odds feed carried ZERO cards/bookings markets across all 33 bookmakers
// checked in the DEFAULT (retail) feed.
// 2026-07-03 UPDATE (EDGE-FIX tier 6): the bookmaker=4 (Pinnacle) feed DOES
// carry "Cards Over/Under" and "Cards Asian Handicap" (verified on fixture
// 1565179). The C9B extractor (buildPinnacleSummaryFromApiFootball) has no
// cards branch yet, so no cards price reaches Claude either way. Flipping this
// flag is gated on EDGE-FIX tier 8.3 (extractor branch + verification across
// 3+ fixtures + prompt update) — pending sign-off.
export const CARDS_MARKET_SOURCE_AVAILABLE = false;

/** Label for a market the current odds source does not carry at all. */
export const CARDS_UNAVAILABLE_LABEL =
  "UNAVAILABLE — not carried by current odds source (verified across 33 bookmakers, July 2026)";

/** Short pill variant of the above for tight UI contexts. */
export const CARDS_UNAVAILABLE_SHORT = "UNAVAILABLE — data gap";

/** True when a market name refers to cards / bookings. */
export function isCardsMarket(name: string | null | undefined): boolean {
  return /card|booking/i.test(String(name ?? ""));
}
