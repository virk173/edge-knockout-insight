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

// ── Analyst-note de-jargonizer (UI cleanup 2026-07-05) ──
// The analyst_note is free-form Claude prose full of internal codenames
// (C6B, D6, PROPAGATING, pct…). These substitutions translate the codes to
// plain phrases while keeping the code in parentheses so the technical
// reader can still cross-reference. Order matters: longer/more specific
// patterns first so e.g. C6B never gets caught by the C6 rule.
const JARGON_SUBSTITUTIONS: Array<[RegExp, string]> = [
  [/\b3-signal CONFLICT\b/g, "three-way disagreement between the goal estimates (CONFLICT)"],
  [/\bAPP-POISSON\b/g, "the app's goals model"],
  [/\bAPP-Poisson\b/g, "the app's goals model"],
  [/\bR16\b/g, "Round-of-16"],
  [/\bH2H gate\b/gi, "head-to-head history requirement"],
  [/\bH2H\b/g, "head-to-head"],
  [/\bBTTS\b/g, "Both Teams To Score"],
  [/\bC6B\b/g, "the player-stats feed (C6B)"],
  [/\bC6\b/g, "the lineup feed (C6)"],
  [/\bC5\b/g, "the injury feed (C5)"],
  [/\bC7\b/g, "the referee feed (C7)"],
  [/\bC8\b/g, "the prediction feed (C8)"],
  [/\bC9A\b/g, "the retail-odds feed (C9A)"],
  [/\bC9B\b/g, "the Pinnacle-odds feed (C9B)"],
  [/\bD1\b/g, "form (D1)"],
  [/\bD2\b/g, "tactical (D2)"],
  [/\bD3\b/g, "context (D3)"],
  [/\bD4\b/g, "injuries (D4)"],
  [/\bD5\b/g, "referee (D5)"],
  [/\bD6\b/g, "head-to-head (D6)"],
  [/\bPROPAGATING state\b/g, "still-publishing (PROPAGATING) state"],
  [/\bPROPAGATING\b/g, "still publishing (PROPAGATING)"],
  [/\breturned EMPTY\b/g, "returned no data (EMPTY)"],
  [/\bEMPTY\b/g, "no data"],
  [/\bgap-scored\b/g, "measured"],
  [/\bgap score\b/gi, "impact score"],
  [/\bSGP\b/g, "same-game parlay"],
  [/\bCLV\b/g, "closing-line value"],
  [/\bxG-proxy\b/g, "shots-on-target stand-in for expected goals"],
  [/\bCONFLICT\b/g, "disagreement (CONFLICT)"],
  [/(\d)pct\b/g, "$1%"],
  [/\bpct\b/g, "%"],
];

/**
 * Translate internal codenames in free-form Claude prose to plain phrases.
 * Each substitution is stashed behind a placeholder until the end so a later
 * rule can never re-match text an earlier rule inserted (e.g. the standalone
 * CONFLICT rule re-hitting the "(CONFLICT)" kept by the 3-signal rule).
 */
export function dejargonize(text: string): string {
  const stash: string[] = [];
  let out = text;
  for (const [re, replacement] of JARGON_SUBSTITUTIONS) {
    out = out.replace(re, (...args) => {
      const groups = args.slice(1, -2) as string[];
      const resolved = replacement.replace(/\$(\d)/g, (_, g: string) => {
        return groups[Number(g) - 1] ?? "";
      });
      stash.push(resolved);
      return `\uE000${stash.length - 1}\uE000`;
    });
  }
  return out.replace(/\uE000(\d+)\uE000/g, (_, i: string) => stash[Number(i)] ?? "");
}

// A sentence longer than this reads badly as a single bullet — split it at
// its em-dashes into separate bullets.
const BULLET_SPLIT_THRESHOLD = 180;

/**
 * Turn a free-form analyst note into plain-English bullet points:
 * de-jargonize, split into sentences (safe against decimals like "2.5"),
 * and break overlong sentences at em-dashes.
 */
export function analystNoteBullets(note: string): string[] {
  // Split the RAW note first — de-jargonizing can lowercase a sentence start
  // ("H2H gate failed" → "head-to-head history requirement failed"), which
  // would defeat the uppercase-lookahead below and merge two sentences.
  // Split after ., ! or ? followed by whitespace and an uppercase/quote/paren
  // start — a decimal point ("Over 2.5 Goals") has no following space, so it
  // never splits.
  const sentences = note
    .trim()
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/)
    .map((s) => dejargonize(s.trim()))
    .filter(Boolean);
  const bullets: string[] = [];
  for (const sentence of sentences) {
    const parts =
      sentence.length > BULLET_SPLIT_THRESHOLD
        ? sentence.split(/\s+—\s+/).map((p) => p.trim())
        : [sentence];
    for (const part of parts) {
      if (!part) continue;
      bullets.push(part.charAt(0).toUpperCase() + part.slice(1));
    }
  }
  return bullets;
}
