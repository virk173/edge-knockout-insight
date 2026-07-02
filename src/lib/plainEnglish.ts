// FIX 5 — plain-English translations for the technical validation / confidence /
// bet-status lines. Maps by keyword with a safe default fallback so any unknown
// technical string still renders something sensible. The technical text is
// always kept in the UI; these render underneath in muted, smaller type.

const DEFAULT_PLAIN = "Technical check — see docs.";

/** Ensemble / alignment states. */
export function plainEnsembleAlignment(alignment: string | null | undefined): string {
  switch ((alignment ?? "").toUpperCase()) {
    case "TRIPLE":
      return "All 3 agree — confidence bonus.";
    case "MAJORITY":
      return "2 of our 3 goal estimates agree — decent agreement, no confidence change.";
    case "CONFLICT":
      return "Estimates disagree — confidence reduced.";
    default:
      return DEFAULT_PLAIN;
  }
}

/** model_probabilities absence. */
export function plainModelProbabilities(present: boolean): string {
  return present
    ? "Claude included its match-winner percentages."
    : "Claude didn't include its match-winner percentages — cosmetic, doesn't affect bets.";
}

/** dimension_weights mismatch. */
export function plainDimensionWeights(mismatch: boolean): string {
  return mismatch
    ? "Claude mis-split its 100 analysis points; the app re-balanced them. No action needed."
    : "The 100 analysis points were split correctly.";
}

/** Confidence-adjustment rows, matched by keyword. */
export function plainConfidenceAdjustment(label: string): string {
  const s = (label ?? "").toLowerCase();
  if (s.includes("data_quality") && s.includes("partial"))
    return "Some data sources were missing (-7).";
  if (s.includes("c5") && s.includes("empty")) return "No injury info (-5).";
  if (s.includes("c6b") && s.includes("empty")) return "No player stats (-3).";
  if (s.includes("h2h") && (s.includes("gate") || s.includes("fail")))
    return "Not enough head-to-head history (0 — weight moved elsewhere).";
  return DEFAULT_PLAIN;
}

/** Bet inactive reasons, matched by keyword. */
export function plainBetReason(reason: string): string {
  const s = (reason ?? "").toLowerCase();
  if (s.includes("ev") && s.includes("negativ"))
    return "The price is worse than our estimated chance — no value, don't bet.";
  if (s.includes("too_small") || s.includes("too small"))
    return "Edge too small to be worth real money.";
  return DEFAULT_PLAIN;
}

/** CLV explanation. */
export function plainCLV(): string {
  return "Did you get a better price than the final pre-kickoff price? Positive = you beat the market.";
}
