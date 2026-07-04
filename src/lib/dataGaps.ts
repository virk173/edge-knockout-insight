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
// 1565179).
// 2026-07-04 (EDGE-FIX tier 8.3): the C9B extractor
// (buildPinnacleSummaryFromApiFootball) now has a cards branch, so a real
// Pinnacle cards price reaches Claude whenever bookmaker=4 offers the market
// — flag flipped to true. The RETAIL (Stake/C9A) feed still carries no cards,
// so a cards recommendation is priced off the Pinnacle reference and the
// executable Stake price must be checked at bet time.
export const CARDS_MARKET_SOURCE_AVAILABLE: boolean = true;

/** Label for a cards price the odds sources did not carry for this match. */
export const CARDS_UNAVAILABLE_LABEL =
  "UNAVAILABLE — no cards price this match (retail feed carries none; Pinnacle C9B offered no cards market this run)";

/** Short pill variant of the above for tight UI contexts. */
export const CARDS_UNAVAILABLE_SHORT = "UNAVAILABLE — no cards price this run";

/** True when a market name refers to cards / bookings. */
export function isCardsMarket(name: string | null | undefined): boolean {
  return /card|booking/i.test(String(name ?? ""));
}
