/**
 * calculate.ts — application-side mathematics for the betting engine.
 *
 * Claude is instructed (see src/lib/systemPrompt.ts) to output RAW VARIABLES
 * only for every quantitative field, never the computed result. This module
 * takes Claude's raw JSON output and computes every derived figure:
 *
 *   1. Single-bet EV          (bet_1.ev, bet_2.ev)
 *   2. Parlay / jackpot EV     (bet_3.parlay_ev, bet_4.jackpot_ev)
 *   3. Gap scores              (player_intelligence.absences[].gap_score)
 *   4. Confidence score        (confidence_scores.final_confidence)
 *   5. Stacked multipliers     (player_intelligence.absences[].stacked_multiplier)
 *   6. Overround / true implied(overround_stake + per-outcome true_implied)
 *
 * The betting cards render from this enriched output, so the displayed numbers
 * are mathematically correct regardless of Claude's own arithmetic.
 */

import type {
  AltitudeAdjustment,
  AnalysisResult,
  ConfidenceAdjustment,
  DimensionWeights,
  DimensionWeightsValidation,
  JackpotBet,
  ModelProbabilities,
  RestDisparity,
  SgpBet,
  StraightBet,
  TravelBurden,
} from "@/lib/analysisResult";
import { getVenueData } from "@/lib/venueData";
import { resolveMarketType, generateStakeLabel } from "@/lib/bettingGlossary";
import { BANKROLL_DEFAULTS } from "@/lib/bankroll";
import { calibrateProbability, DEFAULT_LAMBDA } from "@/lib/calibration";

/*
 * KNOWN GAPS — see also analyse.ts
 *
 * GAP 3 (continued): Opponent-strength normalization is absent from
 * computeGapScore(). The function uses raw tournament goals/assists without
 * weighting by opponent quality. Intentional — no data source available to
 * fix this.
 *
 * GAP 2 (continued): adjustEVForPinnacleGap() is correctly implemented and
 * will fire correctly when pinnacle_odds is not null. As of WC2026 Round of
 * 32, all tested matches returned Bet365 from TheStatsAPI. This path is
 * unverified with real Pinnacle data but structurally correct.
 */


// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
const STACKED_FLOOR = 0.65;

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number.parseFloat(v.replace(/[^0-9.+-]/g, ""));
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function round(n: number, dp = 3): number {
  const f = 10 ** dp;
  return Math.round((n + Number.EPSILON) * f) / f;
}

/** Deep clone so the original raw output is never mutated. */
function clone<T>(value: T): T {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

// ─────────────────────────────────────────────────────────────
// 1 & 2 — Expected value:  ev = (probability × decimal_odds) − 1
// ─────────────────────────────────────────────────────────────
export function computeEv(
  probability?: number,
  decimalOdds?: number,
): number | undefined {
  const p = num(probability);
  const o = num(decimalOdds);
  if (p === undefined || o === undefined) return undefined;
  return round(p * o - 1);
}

/**
 * Single-bet EV from a raw-variable object (EvInputs shape).
 * Thin, object-input wrapper over computeEv so call sites and tests can use
 * the same { model_probability, decimal_odds } convention as the rest of the
 * codebase. Returns a concrete number: an invalid/empty input floors to -1
 * (total stake loss), never NaN or undefined.
 */
export function calculateEV(inputs: {
  model_probability?: number;
  decimal_odds?: number;
}): number {
  return computeEv(inputs.model_probability, inputs.decimal_odds) ?? -1;
}

/**
 * Same-game-parlay / parlay EV from raw variables (ParlayEvInputs shape):
 *   parlay_ev = p_joint × stake_sgp − 1
 *
 * CRITICAL — the hold_rate (the bookmaker's SGP margin) is ALREADY embedded in
 * the offered `stake_sgp` price. It must NOT be subtracted again from either the
 * probability or the price. Applying (1 − hold_rate) twice (the old
 * p_final / effective_sgp_price formula) mechanically drove every parlay to
 * ≈ −0.39 regardless of the match. hold_rate is retained as a DIAGNOSTIC field
 * only (surfaced so the user sees how much the SGP builder skims) and never
 * enters this calculation.
 *
 * Legacy `p_final` / `effective_sgp_price` inputs are accepted as a fallback so
 * older cached results still render, but new analyses supply p_joint + stake_sgp.
 */
export function calculateSGPEV(inputs: {
  p_joint?: number;
  stake_sgp?: number;
  // legacy (deprecated) — pre-fix double-vig inputs, kept for backward-compat.
  p_final?: number;
  effective_sgp_price?: number;
}): number {
  const prob = inputs.p_joint ?? inputs.p_final;
  const price = inputs.stake_sgp ?? inputs.effective_sgp_price;
  return computeEv(prob, price) ?? -1;
}

// ─────────────────────────────────────────────────────────────
// 2b — Bankroll-based fractional-Kelly stake sizing
//   full_kelly       = ev / (decimal_odds − 1)
//   raw_stake        = full_kelly × fraction × bankroll
//   cap              = bankroll × max_bet_pct
//
//   NO floors. Stakes scale purely with the live bankroll. A Kelly stake
//   below min_actionable is SKIPPED (edge too small), never floored up.
//   When the cap clamps the stake we round DOWN (Math.floor) so the displayed
//   stake never exceeds the cap; otherwise round to nearest dollar (Math.round).
//
//   Negative or zero EV returns all zeros with skipped_too_small false.
// ─────────────────────────────────────────────────────────────
export const calculateKellyStake = (inputs: {
  ev: number;
  decimal_odds: number;
  bankroll: number;
  fraction: number;
  max_bet_pct: number;
  min_actionable: number;
}): {
  full_kelly_pct: number;
  fractional_kelly_pct: number;
  raw_stake: number;
  recommended_stake: number;
  capped: boolean;
  skipped_too_small: boolean;
  reasoning: string;
} => {
  if (inputs.ev <= 0) {
    return {
      full_kelly_pct: 0,
      fractional_kelly_pct: 0,
      raw_stake: 0,
      recommended_stake: 0,
      capped: false,
      skipped_too_small: false,
      reasoning: "Negative or zero EV",
    };
  }

  const full_kelly = inputs.ev / (inputs.decimal_odds - 1);
  const fractional_kelly = full_kelly * inputs.fraction;
  const raw_stake = Math.round(fractional_kelly * inputs.bankroll * 100) / 100;
  const cap = inputs.bankroll * inputs.max_bet_pct;

  const full_kelly_pct = Math.round(full_kelly * 1000) / 10;
  const fractional_kelly_pct = Math.round(fractional_kelly * 1000) / 10;

  if (raw_stake < inputs.min_actionable) {
    return {
      full_kelly_pct,
      fractional_kelly_pct,
      raw_stake,
      recommended_stake: 0,
      capped: false,
      skipped_too_small: true,
      reasoning:
        `Kelly stake $${raw_stake.toFixed(2)} below $${inputs.min_actionable} minimum — ` +
        `edge too small relative to bankroll to be worth placing. No bet.`,
    };
  }

  const capped = raw_stake > cap;
  const recommended_stake = capped ? Math.floor(cap) : Math.round(raw_stake);

  let reasoning =
    `Full Kelly ${full_kelly_pct.toFixed(1)}% → ` +
    `${(inputs.fraction * 100).toFixed(0)}% fractional = ` +
    `${fractional_kelly_pct.toFixed(1)}% of $${inputs.bankroll} = ` +
    `$${raw_stake.toFixed(2)}`;
  if (capped) {
    reasoning += ` → capped at ${(inputs.max_bet_pct * 100).toFixed(1)}% = $${cap.toFixed(2)}`;
  }

  return {
    full_kelly_pct,
    fractional_kelly_pct,
    raw_stake,
    recommended_stake,
    capped,
    skipped_too_small: false,
    reasoning,
  };
};

// ─────────────────────────────────────────────────────────────
// 1b — Stake-anchoring bias correction.
//   EV is computed against Stake's line. When a Pinnacle (sharp)
//   reference is available, the gap between the two lines tells us
//   whether an apparent "edge" is genuine probability mismatch or
//   just Stake's line being soft. Adjust EV + confidence to reflect
//   that, rather than trusting Stake's line at face value.
// ─────────────────────────────────────────────────────────────
export const adjustEVForPinnacleGap = (inputs: {
  raw_ev: number;
  stake_odds: number;
  pinnacle_odds: number | null;
}): {
  adjusted_ev: number;
  ev_confidence: "HIGH" | "MEDIUM" | "LOW";
  note: string;
} => {
  if (!inputs.pinnacle_odds) {
    return {
      adjusted_ev: inputs.raw_ev,
      ev_confidence: "MEDIUM",
      note:
        "No Pinnacle reference available. EV based on Stake line alone — unverified against sharp market.",
    };
  }

  const gap_pct = (inputs.stake_odds / inputs.pinnacle_odds - 1) * 100;

  if (gap_pct > 5) {
    // Stake offers meaningfully better odds than Pinnacle — could be
    // genuine value OR Stake mispricing. Flag for caution, don't kill it.
    return {
      adjusted_ev: round(inputs.raw_ev * 0.85),
      ev_confidence: "MEDIUM",
      note: `Stake odds ${gap_pct.toFixed(1)}% better than Pinnacle. EV reduced 15% — part of this "edge" may be Stake line inefficiency rather than true value. Cross-check before staking.`,
    };
  }

  if (gap_pct < -3) {
    // Stake is WORSE than Pinnacle, yet still EV positive — stronger signal.
    // FIX 4: raise CONFIDENCE only, never EV. Kelly sizes stakes directly from
    // adjusted_ev, so inflating EV here would inflate every downstream stake.
    return {
      adjusted_ev: inputs.raw_ev,
      ev_confidence: "HIGH",
      note: `Stake odds ${Math.abs(gap_pct).toFixed(1)}% worse than Pinnacle, yet still EV positive. Confidence raised to HIGH — EV left unchanged (sizing stays honest). Model disagrees with the sharper market in your favor.`,
    };
  }

  return {
    adjusted_ev: inputs.raw_ev,
    ev_confidence: "HIGH",
    note:
      "Stake and Pinnacle aligned within 5%. EV reflects genuine model disagreement with an efficient market.",
  };
};

// ─────────────────────────────────────────────────────────────
// 3 — Gap score
//   gap = (goals × 8) + (assists × 5) + (shots_delta × 7)
//       + (keypasses_delta × 5) + set_piece_weight
// ─────────────────────────────────────────────────────────────
export function computeGapScore(inputs?: {
  actual_goals?: number;
  actual_assists?: number;
  shots_pg_delta?: number;
  keypasses_pg_delta?: number;
  set_piece_weight?: number;
}): number | undefined {
  if (!inputs) return undefined;
  const goals = num(inputs.actual_goals) ?? 0;
  const assists = num(inputs.actual_assists) ?? 0;
  const shots = num(inputs.shots_pg_delta) ?? 0;
  const kp = num(inputs.keypasses_pg_delta) ?? 0;
  const setPiece = num(inputs.set_piece_weight) ?? 0;
  return round(
    goals * 8 + assists * 5 + shots * 7 + kp * 5 + setPiece,
    1,
  );
}

// ─────────────────────────────────────────────────────────────
// 4 — Ensemble alignment (single source of truth)
//   Derived purely from the three signal probabilities so the
//   alignment label and confidence_impact can never disagree with
//   the confidence-score math (computeConfidence calls this).
// ─────────────────────────────────────────────────────────────
export const calculateEnsembleAlignment = (signals: {
  signal_1_model: number;
  signal_2_poisson: number;
  signal_3_historical: number;
}): {
  alignment: "TRIPLE ALIGNED" | "MAJORITY" | "CONFLICT";
  max_pairwise_diff: number;
  confidence_impact: number;
  note: string;
} => {
  const s1 = signals.signal_1_model;
  const s2 = signals.signal_2_poisson;
  const s3 = signals.signal_3_historical;

  const diff12 = Math.abs(s1 - s2);
  const diff13 = Math.abs(s1 - s3);
  const diff23 = Math.abs(s2 - s3);
  const maxDiff = Math.max(diff12, diff13, diff23);

  if (maxDiff <= 0.3) {
    return {
      alignment: "TRIPLE ALIGNED",
      max_pairwise_diff: maxDiff,
      confidence_impact: 5,
      note: `All three signals within 0.3 of each other (max diff ${maxDiff.toFixed(
        2,
      )}). Confidence +5.`,
    };
  }

  // count how many pairs are within 0.3
  const pairsAligned = [diff12, diff13, diff23].filter((d) => d <= 0.3).length;

  if (pairsAligned >= 1) {
    return {
      alignment: "MAJORITY",
      max_pairwise_diff: maxDiff,
      confidence_impact: 0,
      note: `2 of 3 signals aligned within 0.3 (max diff ${maxDiff.toFixed(
        2,
      )}). No confidence change.`,
    };
  }

  return {
    alignment: "CONFLICT",
    max_pairwise_diff: maxDiff,
    confidence_impact: -5,
    note: `All signals diverge above 0.3 (max diff ${maxDiff.toFixed(
      2,
    )}). Confidence -5, data_quality forced PARTIAL.`,
  };
};

// ─────────────────────────────────────────────────────────────
// 4 — Confidence score
//   post_adj = raw + Σ(deltas)
//   if post_adj > 75:  final = 75 + (post_adj − 75) × 0.40
//   else:              final = post_adj
//
//   The ensemble-alignment delta is NOT trusted from Claude. When the
//   three ensemble signals are supplied, computeConfidence calls
//   calculateEnsembleAlignment() and substitutes its confidence_impact
//   for any Claude-provided "ensemble" adjustment, so the confidence
//   math and ensemble_check.alignment share one source of truth.
// ─────────────────────────────────────────────────────────────
export function computeConfidence(
  inputs?: {
    dimension_weighted_raw?: number;
    adjustments?: ConfidenceAdjustment[];
  },
  ensembleSignals?: {
    signal_1_model?: number;
    signal_2_poisson?: number;
    signal_3_historical?: number;
  },
): {
  post_adjustment: number;
  final_confidence: number;
  bayesian_applied: boolean;
  adjustments: ConfidenceAdjustment[];
  ensemble_impact?: number;
} | undefined {
  if (!inputs) return undefined;
  const raw = num(inputs.dimension_weighted_raw);
  if (raw === undefined) return undefined;

  let adjustments: ConfidenceAdjustment[] = [...(inputs.adjustments ?? [])];
  let ensembleImpact: number | undefined;

  const s1 = num(ensembleSignals?.signal_1_model);
  const s2 = num(ensembleSignals?.signal_2_poisson);
  const s3 = num(ensembleSignals?.signal_3_historical);
  if (s1 !== undefined && s2 !== undefined && s3 !== undefined) {
    const ensemble = calculateEnsembleAlignment({
      signal_1_model: s1,
      signal_2_poisson: s2,
      signal_3_historical: s3,
    });
    ensembleImpact = ensemble.confidence_impact;
    // FIX 1: Claude's STEP 6 + few-shot make it emit its own ensemble/signal/
    // conflict/alignment/poisson adjustment (e.g. {"type":"3_signal_conflict",
    // "delta":-5}). The app then injects its OWN app-computed ensemble delta —
    // counting the same phenomenon twice. Drop ANY Claude adjustment that names
    // this dimension, then inject the single app-computed value below.
    adjustments = adjustments.filter(
      (a) =>
        !/ensemble|signal|conflict|aligned|poisson/i.test(a?.type ?? ""),
    );
    adjustments.push({ type: "ensemble_alignment", delta: ensembleImpact });
  }

  const sum = adjustments.reduce((acc, a) => acc + (num(a?.delta) ?? 0), 0);
  const postAdj = raw + sum;
  const bayesian = postAdj > 75;
  const final = bayesian ? 75 + (postAdj - 75) * 0.4 : postAdj;
  return {
    post_adjustment: round(postAdj, 1),
    final_confidence: round(final, 1),
    bayesian_applied: bayesian,
    adjustments,
    ensemble_impact: ensembleImpact,
  };
}

// ─────────────────────────────────────────────────────────────
// 5 — Stacked multiplier
//   stacked = gap_multiplier × depth_multiplier
//   if stacked < 0.65:  stacked = 0.65
// ─────────────────────────────────────────────────────────────
export function computeStackedMultiplier(inputs?: {
  gap_multiplier?: number;
  depth_multiplier?: number;
}): { stacked_multiplier: number; floor_applied: boolean } | undefined {
  if (!inputs) return undefined;
  const gap = num(inputs.gap_multiplier);
  const depth = num(inputs.depth_multiplier);
  if (gap === undefined || depth === undefined) return undefined;
  const raw = gap * depth;
  const floored = raw < STACKED_FLOOR;
  return {
    stacked_multiplier: round(floored ? STACKED_FLOOR : raw, 3),
    floor_applied: floored,
  };
}

// ─────────────────────────────────────────────────────────────
// 6 — Overround
//   overround = Σ(1 / odds for each outcome)
//   true_implied = raw_implied / overround   (raw_implied = 1 / odds)
// ─────────────────────────────────────────────────────────────
export function computeOverround(
  outcomes?: { name?: string; odds?: number }[],
): {
  overround: number;
  outcomes: { name?: string; odds?: number; raw_implied: number; true_implied: number }[];
} | undefined {
  if (!Array.isArray(outcomes) || outcomes.length === 0) return undefined;
  type Enriched = { name?: string; odds: number; raw_implied: number };
  const enriched: Enriched[] = [];
  for (const o of outcomes) {
    const odds = num(o?.odds);
    if (odds && odds > 0) {
      enriched.push({ name: o?.name, odds, raw_implied: 1 / odds });
    }
  }
  if (enriched.length === 0) return undefined;
  const overround = enriched.reduce((acc, o) => acc + o.raw_implied, 0);
  return {
    overround: round(overround, 4),
    outcomes: enriched.map((o) => ({
      name: o.name,
      odds: o.odds,
      raw_implied: round(o.raw_implied, 4),
      true_implied: round(overround > 0 ? o.raw_implied / overround : 0, 4),
    })),
  };
}

// ─────────────────────────────────────────────────────────────
// 7 — Altitude adjustment (uses static venue altitude + team history)
// ─────────────────────────────────────────────────────────────
export const calculateAltitudeAdjustment = (inputs: {
  venue_altitude_m: number;
  home_team_last5_avg_altitude: number;
  away_team_last5_avg_altitude: number;
}): AltitudeAdjustment => {
  const HIGH_ALTITUDE_THRESHOLD = 1500;
  const ADAPTATION_THRESHOLD = 1000;

  if (inputs.venue_altitude_m < HIGH_ALTITUDE_THRESHOLD) {
    return {
      applies_to: null,
      pressing_multiplier: 1.0,
      et_probability_delta: 0,
      note: "Venue below altitude threshold, no adjustment.",
    };
  }

  const homeAdapted =
    inputs.home_team_last5_avg_altitude > ADAPTATION_THRESHOLD;
  const awayAdapted =
    inputs.away_team_last5_avg_altitude > ADAPTATION_THRESHOLD;

  if (!homeAdapted && !awayAdapted) {
    return {
      applies_to: null,
      pressing_multiplier: 0.95,
      et_probability_delta: 3,
      note: `Both teams unadapted to ${inputs.venue_altitude_m}m. Neutral disadvantage applied to both equally — net effect on relative probabilities is minimal.`,
    };
  }

  if (!awayAdapted && homeAdapted) {
    return {
      applies_to: "away",
      pressing_multiplier: 0.9,
      et_probability_delta: 5,
      note: `Away team unadapted to ${inputs.venue_altitude_m}m altitude. Second-half pressing intensity reduced.`,
    };
  }

  if (!homeAdapted && awayAdapted) {
    return {
      applies_to: "home",
      pressing_multiplier: 0.9,
      et_probability_delta: 5,
      note: `Home team unadapted to ${inputs.venue_altitude_m}m altitude despite home venue.`,
    };
  }

  return {
    applies_to: null,
    pressing_multiplier: 1.0,
    et_probability_delta: 0,
    note: "Both teams adapted to altitude. No adjustment.",
  };
};

// ─────────────────────────────────────────────────────────────
// 8 — Rest disparity (arithmetic on existing C4 fixture dates)
// ─────────────────────────────────────────────────────────────
export const calculateRestDisparity = (inputs: {
  home_last_fixture_date: string;
  away_last_fixture_date: string;
  kickoff_utc: string;
  current_round: string;
}): RestDisparity => {
  const kickoff = new Date(inputs.kickoff_utc).getTime();
  const homeRest =
    (kickoff - new Date(inputs.home_last_fixture_date).getTime()) / 3600000;
  const awayRest =
    (kickoff - new Date(inputs.away_last_fixture_date).getTime()) / 3600000;
  const disparity = Math.abs(homeRest - awayRest);

  const isLateStage = [
    "Round of 16",
    "Quarter-Finals",
    "Semi-Finals",
    "Final",
  ].some((r) => (inputs.current_round ?? "").includes(r));

  if (!Number.isFinite(disparity) || disparity < 24) {
    return {
      rest_hours_home: homeRest,
      rest_hours_away: awayRest,
      disparity_hours: Number.isFinite(disparity) ? disparity : 0,
      fatigued_team: null,
      goals_multiplier: 1.0,
      upset_probability_delta: 0,
      note: "Rest disparity under 24h threshold. No adjustment.",
    };
  }

  const fatiguedTeam = homeRest < awayRest ? "home" : "away";
  const multiplier = isLateStage ? 0.9 : 0.95;
  const upsetDelta = isLateStage ? 5 : 3;

  return {
    rest_hours_home: homeRest,
    rest_hours_away: awayRest,
    disparity_hours: disparity,
    fatigued_team: fatiguedTeam,
    goals_multiplier: multiplier,
    upset_probability_delta: upsetDelta,
    note: `${fatiguedTeam} team has ${disparity.toFixed(0)}h less rest. ${
      isLateStage ? "Late tournament stage amplifies fatigue impact." : ""
    }`.trim(),
  };
};

// ─────────────────────────────────────────────────────────────
// 9 — Travel timezone burden (static venue tz offsets)
// ─────────────────────────────────────────────────────────────
export const calculateTravelBurden = (inputs: {
  venue_timezone_offset: number;
  home_last_venue_timezone: number;
  away_last_venue_timezone: number;
}): TravelBurden => {
  const homeShift = Math.abs(
    inputs.venue_timezone_offset - inputs.home_last_venue_timezone,
  );
  const awayShift = Math.abs(
    inputs.venue_timezone_offset - inputs.away_last_venue_timezone,
  );

  if (homeShift < 3 && awayShift < 3) {
    return {
      home_timezone_shift: homeShift,
      away_timezone_shift: awayShift,
      disparity: Math.abs(homeShift - awayShift),
      burdened_team: null,
      pressing_multiplier: 1.0,
      note: "Neither team crossed 3+ timezones. No adjustment.",
    };
  }

  const burdenedTeam = homeShift > awayShift ? "home" : "away";

  return {
    home_timezone_shift: homeShift,
    away_timezone_shift: awayShift,
    disparity: Math.abs(homeShift - awayShift),
    burdened_team: burdenedTeam,
    pressing_multiplier: 0.92,
    note: `${burdenedTeam} team crossed ${Math.max(
      homeShift,
      awayShift,
    )} timezones since last fixture.`,
  };
};


// ─────────────────────────────────────────────────────────────
// Validation — model probabilities (proportional rescale to 100)
// ─────────────────────────────────────────────────────────────
export const validateModelProbabilities = (probs: {
  home: number;
  draw: number;
  away: number;
}): {
  home: number;
  draw: number;
  away: number;
  was_normalized: boolean;
  raw_sum: number;
} => {
  const sum = probs.home + probs.draw + probs.away;

  if (Math.abs(sum - 100) < 0.5) {
    return {
      ...probs,
      was_normalized: false,
      raw_sum: sum,
    };
  }

  // Proportionally rescale to sum to 100
  const scale = 100 / sum;
  return {
    home: Math.round(probs.home * scale * 100) / 100,
    draw: Math.round(probs.draw * scale * 100) / 100,
    away: Math.round(probs.away * scale * 100) / 100,
    was_normalized: true,
    raw_sum: sum,
  };
};

// ─────────────────────────────────────────────────────────────
// Validation — dimension weights (against actual trigger conditions)
//   Surfaces mismatches as flags; does NOT auto-correct the weights
//   because Claude's weighted reasoning already happened upstream.
// ─────────────────────────────────────────────────────────────
export const validateDimensionWeights = (inputs: {
  weights: DimensionWeights | null;
  call4_fixture_count: number;
  h2h_gate_passed: boolean;
  critical_absence_present: boolean;
  all_players_confirmed_fit: boolean;
}): DimensionWeightsValidation => {
  // Guard: Claude can omit dimension_weights entirely. Report a NOT-RUN state
  // rather than throwing on a null dereference below.
  if (!inputs.weights) {
    return {
      weights: null,
      expected_weights: null,
      mismatch_flags: [
        "dimension_weights field was missing — validation could not run.",
      ],
      sum_valid: false,
      validation_ran: false,
    };
  }

  // Determine expected weights from actual data conditions, independent
  // of what Claude claimed.
  const expected: DimensionWeights = {
    D1: 35,
    D2: 25,
    D3: 20,
    D4: 10,
    D5: 5,
    D6: 5,
  };

  if (inputs.call4_fixture_count < 3) {
    expected.D2 = 15;
    expected.D1 = 45;
  }

  if (!inputs.h2h_gate_passed) {
    expected.D6 = 0;
    expected.D1 = inputs.call4_fixture_count < 3 ? 45 : 40;
  }

  if (inputs.critical_absence_present) {
    expected.D4 = 18;
    expected.D2 = 17;
  } else if (inputs.all_players_confirmed_fit) {
    expected.D4 = 5;
    expected.D1 = 40;
  }

  const weights = inputs.weights;
  const mismatchFlags: string[] = [];
  (Object.keys(expected) as (keyof DimensionWeights)[]).forEach((k) => {
    if (Math.abs(weights[k] - expected[k]) > 2) {
      mismatchFlags.push(
        `${k}: Claude used ${weights[k]}, expected ${expected[k]} given data conditions.`,
      );
    }
  });

  const sum = Object.values(weights).reduce((a, b) => a + b, 0);
  const sumValid = Math.abs(sum - 100) < 1;
  if (!sumValid) {
    mismatchFlags.push(`Dimension weights sum to ${sum}, not 100.`);
  }

  return {
    weights,
    expected_weights: expected,
    mismatch_flags: mismatchFlags,
    sum_valid: sumValid,
    validation_ran: true,
  };
};

/**
 * Scales the six dimension weights by 100/sum so they always total exactly 100,
 * then adds any rounding remainder to D1. Used to repair Claude outputs that
 * don't sum to 100 (e.g. combined H2H-gate + all-fit adjustments producing 95).
 * The mismatch warning is produced separately by validateDimensionWeights against
 * the ORIGINAL (pre-normalization) values, so the warning text is preserved.
 */
export const normalizeDimensionWeights = (
  weights: DimensionWeights,
): DimensionWeights => {
  const keys: (keyof DimensionWeights)[] = ["D1", "D2", "D3", "D4", "D5", "D6"];
  const sum = keys.reduce((a, k) => a + (Number(weights[k]) || 0), 0);
  if (sum <= 0) return { ...weights };
  const scaled: DimensionWeights = { ...weights };
  keys.forEach((k) => {
    scaled[k] = Math.round(((Number(weights[k]) || 0) * 100) / sum);
  });
  // Fix any rounding remainder by adjusting D1 so the total is exactly 100.
  const scaledSum = keys.reduce((a, k) => a + scaled[k], 0);
  scaled.D1 += 100 - scaledSum;
  return scaled;
};


// ─────────────────────────────────────────────────────────────
// Orchestrator
// ─────────────────────────────────────────────────────────────
/**
 * Takes Claude's raw JSON output and returns an enriched copy where every
 * quantitative field has been (re)computed from the raw *_inputs variables.
 * If a given *_inputs block is absent, any value Claude already provided is
 * left untouched so the dashboard still renders.
 */
export function calculateResults(
  rawOutput: unknown,
  opts?: { bankroll?: number; lambda?: number; strictMode?: boolean },
): AnalysisResult {
  if (!rawOutput || typeof rawOutput !== "object") {
    return (rawOutput ?? {}) as AnalysisResult;
  }

  const result = clone(rawOutput) as AnalysisResult;

  // Live bankroll drives all sizing. Defaults to STARTING_BANKROLL (tests).
  const bankroll = num(opts?.bankroll) ?? BANKROLL_DEFAULTS.STARTING_BANKROLL;
  result.bankroll_at_analysis = bankroll;

  // Calibration shrink factor λ (fit from settled results). Defaults to the
  // prior 0.7. EV/Kelly for straight bets run on the CALIBRATED probability.
  const lambda = num(opts?.lambda) ?? DEFAULT_LAMBDA;
  // Strict-signal regime: real money only on bets that pass qualifiesForRealStake;
  // everything else becomes a $0 paper bet. Default ON.
  const strictMode = opts?.strictMode ?? true;

  // Parse home/away team names from the "Home vs Away" match string so
  // stake_labels can be generated from the verified Stake glossary.
  const matchStr = typeof result.match === "string" ? result.match : "";
  const vsSplit = matchStr.split(/\s+vs\.?\s+/i);
  const homeTeam = (vsSplit[0] ?? "Home").trim() || "Home";
  const awayTeam = (vsSplit[1] ?? "Away").trim() || "Away";

  // Generate a verified Stake stake_label from a bet/leg's market + selection.
  const applyStakeLabel = (item: {
    market?: string;
    selection?: string;
    stake_label?: string;
  }) => {
    if (!item?.market) return;
    const marketType = resolveMarketType(item.market);
    if (!marketType) return;
    item.stake_label = generateStakeLabel(
      marketType,
      item.selection ?? "",
      homeTeam,
      awayTeam,
    );
  };

  // ── Straight-bet enrichment (bet_1 + bet_2) ──────────────────
  // Both are single-market straight bets: compute EV, apply the Pinnacle-gap
  // bias correction, then size the stake by fractional Kelly against the LIVE
  // bankroll. Claude no longer supplies any sizing — bankroll + the
  // BANKROLL_DEFAULTS constants own it. Claude kelly_inputs are IGNORED for
  // bankroll/floor/ceiling; only decimal_odds is still read as a fallback.
  const enrichStraightBet = (
    bet: typeof result.bet_1,
    defaults: { minEv: number },
  ) => {
    if (!bet) return;

    // FIX 2 — capture Claude's own skip BEFORE we touch active. We never flip a
    // bet Claude explicitly skipped back to active.
    const claudeSkipped = bet.active === false;

    // EV from raw variables — computed on the CALIBRATED probability.
    if (bet.ev_inputs) {
      const rawModelP = num(bet.ev_inputs.model_probability);
      const odds = num(bet.ev_inputs.decimal_odds);
      // Calibration: shrink the model probability toward the market price by λ
      // (fit from settled results) BEFORE computing EV. EV, the Pinnacle
      // adjustment, the EV gate and Kelly ALL run on this calibrated value so
      // an overconfident model can never inflate a stake.
      if (rawModelP !== undefined && odds !== undefined) {
        const calP = calibrateProbability(rawModelP, odds, lambda);
        bet.model_probability_raw = round(rawModelP, 4);
        bet.model_probability = round(calP, 4);
        bet.calibration_note =
          `Model ${(rawModelP * 100).toFixed(1)}% → shrunk λ=${lambda} ` +
          `toward market ${((1 / odds) * 100).toFixed(1)}% = ${(calP * 100).toFixed(1)}%`;
        bet.odds = bet.odds ?? odds;
        const ev = computeEv(calP, odds);
        if (ev !== undefined) bet.ev = ev;
      } else {
        const ev = computeEv(rawModelP, odds);
        if (ev !== undefined) {
          bet.ev = ev;
          if (bet.model_probability === undefined) bet.model_probability = rawModelP;
          if (bet.odds === undefined) bet.odds = odds;
        }
      }
    }

    // Stake-anchoring bias correction.
    if (bet.ev !== undefined && bet.odds !== undefined) {
      const pinnacleOdds = num(bet.pinnacle_odds) ?? null;
      const adjustment = adjustEVForPinnacleGap({
        raw_ev: bet.ev,
        stake_odds: bet.odds,
        pinnacle_odds: pinnacleOdds,
      });
      bet.raw_ev = bet.ev;
      bet.ev = adjustment.adjusted_ev;
      bet.ev_confidence = adjustment.ev_confidence;
      bet.pinnacle_check_note = adjustment.note;
    }

    // Bankroll-based Kelly sizing from the (adjusted) EV.
    if (bet.ev !== undefined && bet.odds !== undefined) {
      const ki = bet.kelly_inputs ?? {};
      const kelly = calculateKellyStake({
        ev: bet.ev,
        decimal_odds: num(ki.decimal_odds) ?? bet.odds,
        bankroll,
        fraction: BANKROLL_DEFAULTS.KELLY_FRACTION,
        max_bet_pct: BANKROLL_DEFAULTS.MAX_BET_PCT,
        min_actionable: BANKROLL_DEFAULTS.MIN_ACTIONABLE_STAKE,
      });
      bet.kelly_result = kelly;

      bet.ev_rating =
        bet.ev < 0
          ? "NEGATIVE"
          : bet.ev < defaults.minEv
            ? "SKIP"
            : bet.ev < 0.08
              ? "MARGINAL"
              : "STRONG";

      // If Kelly says the edge is too small, mark it — but never overwrite a
      // skip_reason Claude already set.
      if (kelly.skipped_too_small && !bet.skip_reason) {
        bet.skip_reason = kelly.reasoning;
      }

      // FIX 2 — active requires: Claude didn't skip, EV clears the threshold,
      // and Kelly produced an actionable stake.
      bet.active =
        !claudeSkipped && bet.ev >= defaults.minEv && !kelly.skipped_too_small;
      bet.stake = `$${kelly.recommended_stake}`;
    }
  };

  enrichStraightBet(result.bet_1, { minEv: 0.05 });
  enrichStraightBet(result.bet_2, { minEv: 0.03 });

  // Auto-generate verified Stake stake_labels for the straight bets.
  if (result.bet_1) applyStakeLabel(result.bet_1);
  if (result.bet_2) applyStakeLabel(result.bet_2);



  // ── bet_3 — 3-leg SGP EV. parlay_ev = p_joint × stake_sgp − 1 (NO hold_rate
  // term; the hold is already priced into stake_sgp). Falls back to the legacy
  // p_final / effective_sgp_price pair only for old cached results.
  //
  // NOTE: SGP joint probability (p_joint) is NOT calibrated. Calibration shrinks
  // a single model probability toward a single market price, but p_joint is a
  // Claude-derived correlation-adjusted product with no clean market anchor, and
  // the parlay stake is a flat 1% of bankroll regardless of EV — so calibrating
  // it would add noise without changing sizing. It stays Claude-derived.
  const b3 = result.bet_3;
  if (b3?.parlay_ev_inputs) {
    const pj = b3.parlay_ev_inputs.p_joint ?? b3.parlay_ev_inputs.p_final;
    const sp =
      b3.parlay_ev_inputs.stake_sgp ?? b3.parlay_ev_inputs.effective_sgp_price;
    const ev = computeEv(pj, sp);
    if (ev !== undefined) b3.parlay_ev = ev;
  }

  // Stake-anchoring bias correction for any SGP leg with a Pinnacle reference.
  if (Array.isArray(b3?.legs)) {
    for (const leg of b3.legs) {
      const legOdds = num(leg.odds);
      const legProb = num(leg.model_probability);
      if (legOdds === undefined || legProb === undefined) continue;
      const legRawEv = computeEv(legProb, legOdds);
      if (legRawEv === undefined) continue;
      const legPinnacle = num(leg.pinnacle_odds) ?? null;
      const legAdjustment = adjustEVForPinnacleGap({
        raw_ev: legRawEv,
        stake_odds: legOdds,
        pinnacle_odds: legPinnacle,
      });
      leg.raw_ev = legRawEv;
      leg.ev = legAdjustment.adjusted_ev;
      leg.ev_confidence = legAdjustment.ev_confidence;
      leg.pinnacle_check_note = legAdjustment.note;
    }
  }

  // Auto-generate verified Stake stake_labels for each SGP leg.
  if (Array.isArray(b3?.legs)) {
    for (const leg of b3.legs) applyStakeLabel(leg);
  }


  // ── bet_4 — jackpot EV
  const b4 = result.bet_4;
  if (b4?.jackpot_ev_inputs) {
    const ev = computeEv(
      b4.jackpot_ev_inputs.p_final,
      b4.jackpot_ev_inputs.combined_odds,
    );
    if (ev !== undefined) b4.jackpot_ev = ev;
  }

  // Auto-generate verified Stake stake_labels for each jackpot leg.
  if (Array.isArray(b4?.legs)) {
    for (const leg of b4.legs) applyStakeLabel(leg);
  }


  // 3 & 5 — Gap scores + stacked multipliers per absence
  const absences = result.player_intelligence?.absences;
  if (Array.isArray(absences)) {
    for (const a of absences) {
      const gap = computeGapScore(a?.gap_score_inputs);
      if (gap !== undefined) {
        a.gap_score = gap;
        const inputs = a.gap_score_inputs!;
        a.gap_calculation =
          `(${inputs.actual_goals ?? 0}×8) + (${inputs.actual_assists ?? 0}×5) ` +
          `+ (${inputs.shots_pg_delta ?? 0}×7) + (${inputs.keypasses_pg_delta ?? 0}×5) ` +
          `+ ${inputs.set_piece_weight ?? 0} = ${gap}`;
      }
      const mult = computeStackedMultiplier(a?.multiplier_inputs);
      if (mult !== undefined) a.stacked_multiplier = mult.stacked_multiplier;
    }
  }

  // GAP 1 — model probabilities must sum to 100 (proportional rescale).
  if (result.model_probabilities) {
    const validated = validateModelProbabilities({
      home: num(result.model_probabilities.home) ?? 0,
      draw: num(result.model_probabilities.draw) ?? 0,
      away: num(result.model_probabilities.away) ?? 0,
    });
    result.model_probabilities = validated;
    if (validated.was_normalized) {
      result.data_quality_flags = result.data_quality_flags || [];
      result.data_quality_flags.push(
        `Model probabilities summed to ${validated.raw_sum.toFixed(1)}%, normalized to 100%.`,
      );
    }
  }

  // GAP 2 — ensemble alignment is recomputed from the three signals and
  // OVERWRITES whatever Claude stated (single source of truth).
  if (result.ensemble_check) {
    const computed = calculateEnsembleAlignment({
      signal_1_model: num(result.ensemble_check.signal_1_model) ?? 0,
      signal_2_poisson: num(result.ensemble_check.signal_2_poisson) ?? 0,
      signal_3_historical: num(result.ensemble_check.signal_3_historical) ?? 0,
    });

    result.ensemble_check.alignment = computed.alignment;
    result.ensemble_check.confidence_impact = computed.confidence_impact.toString();
    result.ensemble_check.note = computed.note;
    result.ensemble_check.max_pairwise_diff = computed.max_pairwise_diff;

    // Force data_quality PARTIAL on CONFLICT, matching existing rule.
    if (computed.alignment === "CONFLICT" && result.data_quality === "FULL") {
      result.data_quality = "PARTIAL";
    }
  }

  // 4 — Confidence score. Pass the ensemble signals so computeConfidence
  // uses the SAME calculateEnsembleAlignment() impact — no divergence.
  const cs = result.confidence_scores;
  if (cs?.confidence_inputs) {
    const conf = computeConfidence(
      cs.confidence_inputs,
      result.ensemble_check && {
        signal_1_model: num(result.ensemble_check.signal_1_model),
        signal_2_poisson: num(result.ensemble_check.signal_2_poisson),
        signal_3_historical: num(result.ensemble_check.signal_3_historical),
      },
    );
    if (conf !== undefined) {
      cs.dimension_weighted_raw =
        num(cs.confidence_inputs.dimension_weighted_raw) ??
        cs.dimension_weighted_raw;
      cs.adjustments = conf.adjustments;
      cs.post_adjustment = conf.post_adjustment;
      cs.final_confidence = conf.final_confidence;
      cs.bayesian_applied = conf.bayesian_applied;
    }
  }

  // GAP 3 — dimension weights validated against actual data conditions.
  // Surfaced as a flag only; weights are NOT auto-corrected.
  if (result.dimension_weights) {
    const call4Count = result.tactical_analysis?.call4_fixture_count ?? 5;
    const h2hPassed = !result.markets_rejected?.some((m) =>
      (m?.market ?? "").includes("H2H"),
    );
    const criticalAbsence = !!result.player_intelligence?.absences?.some(
      (a) => a?.classification === "CRITICAL",
    );
    const allFit =
      (result.player_intelligence?.absences?.length ?? 0) === 0;

    const validation = validateDimensionWeights({
      weights: {
        D1: num(result.dimension_weights.D1) ?? 0,
        D2: num(result.dimension_weights.D2) ?? 0,
        D3: num(result.dimension_weights.D3) ?? 0,
        D4: num(result.dimension_weights.D4) ?? 0,
        D5: num(result.dimension_weights.D5) ?? 0,
        D6: num(result.dimension_weights.D6) ?? 0,
      },
      call4_fixture_count: call4Count,
      h2h_gate_passed: h2hPassed,
      critical_absence_present: criticalAbsence,
      all_players_confirmed_fit: allFit,
    });
    result.dimension_weights_validation = validation;
    // NORMALIZE the weights so they always sum to exactly 100 before anything
    // downstream reads them. Validation above ran against the ORIGINAL values,
    // so any mismatch warning text is preserved.
    result.dimension_weights = normalizeDimensionWeights({
      D1: num(result.dimension_weights.D1) ?? 0,
      D2: num(result.dimension_weights.D2) ?? 0,
      D3: num(result.dimension_weights.D3) ?? 0,
      D4: num(result.dimension_weights.D4) ?? 0,
      D5: num(result.dimension_weights.D5) ?? 0,
      D6: num(result.dimension_weights.D6) ?? 0,
    });
    if (validation.mismatch_flags.length > 0) {
      result.key_risk_flag =
        (result.key_risk_flag || "") +
        " [WEIGHT VALIDATION: " +
        validation.mismatch_flags.join(" ") +
        "]";
    }
  } else {
    // Field missing from Claude output — flag this explicitly rather than
    // silently skipping validation, so the UI can show a NOT RUN state.
    result.dimension_weights_validation = {
      weights: null,
      expected_weights: null,
      mismatch_flags: [
        "dimension_weights field was missing from Claude output — validation could not run. This indicates the system prompt instruction may not be reaching Claude correctly, or Claude omitted a required field.",
      ],
      sum_valid: false,
      validation_ran: false,
    };
  }

  // 6 — Overround + true implied per outcome
  if (result.overround_inputs?.outcomes) {
    const ov = computeOverround(result.overround_inputs.outcomes);
    if (ov !== undefined) {
      result.overround_stake = ov.overround;
      result.overround_inputs.outcomes = ov.outcomes;
    }
  }

  // 7, 8 & 9 — Contextual factors (altitude, rest, travel).
  // All derived from context_inputs + static venue data — ZERO new API calls.
  const ci = result.context_inputs;
  if (ci) {
    const venue = ci.venue_name ? getVenueData(ci.venue_name) : null;

    if (venue) {
      result.altitude_adjustment = calculateAltitudeAdjustment({
        venue_altitude_m: venue.altitude_m,
        home_team_last5_avg_altitude: num(ci.home_avg_altitude) ?? 0,
        away_team_last5_avg_altitude: num(ci.away_avg_altitude) ?? 0,
      });

      result.travel_burden = calculateTravelBurden({
        venue_timezone_offset: venue.timezone_offset_hours,
        home_last_venue_timezone:
          num(ci.home_last_venue_tz) ?? venue.timezone_offset_hours,
        away_last_venue_timezone:
          num(ci.away_last_venue_tz) ?? venue.timezone_offset_hours,
      });
    }

    if (ci.home_last_fixture_date && ci.away_last_fixture_date) {
      result.rest_disparity = calculateRestDisparity({
        home_last_fixture_date: ci.home_last_fixture_date,
        away_last_fixture_date: ci.away_last_fixture_date,
        kickoff_utc: result.kickoff_UTC ?? "",
        current_round: result.round ?? "",
      });
    }
  }

  // ── EV GATE (single source of truth, runs LAST) ───────────────
  // Re-derive ev_rating from the ACTUAL computed EV for every tier and enforce
  // the absolute rule "Never recommend negative EV bets": any tier whose
  // computed EV is negative is forced inactive and labelled NEGATIVE — no
  // matter what Claude originally proposed. The gate only ever DOWNGRADES
  // (forces active=false); it never flips an inactive tier active, so states
  // like the jackpot's "insufficient signals" skip are preserved.
  // FIX 2 — each tier gates at its own minimum EV (bet_2 at 0.03; the rest 0.05).
  const gateTier = (
    evValue: number | undefined,
    tier: { active?: boolean; ev_rating?: string } | undefined,
    minEv: number,
  ) => {
    if (!tier || evValue === undefined || !Number.isFinite(evValue)) return;
    if (evValue < 0) {
      tier.ev_rating = "NEGATIVE";
      tier.active = false;
    } else if (evValue < minEv) {
      tier.ev_rating = "SKIP";
      tier.active = false;
    } else if (evValue < 0.08) {
      tier.ev_rating = "MARGINAL";
    } else {
      tier.ev_rating = "STRONG";
    }
  };
  gateTier(num(result.bet_1?.ev), result.bet_1, 0.05);
  gateTier(num(result.bet_2?.ev), result.bet_2, 0.03);
  gateTier(num(result.bet_3?.parlay_ev), result.bet_3, 0.05);
  gateTier(num(result.bet_4?.jackpot_ev), result.bet_4, 0.05);

  // If a straight bet was gated inactive, zero its Kelly stake so the UI never
  // shows a stake on a bet the gate killed.
  for (const sb of [result.bet_1, result.bet_2]) {
    if (sb && sb.active === false) {
      sb.stake = "$0";
      if (sb.kelly_result) sb.kelly_result.recommended_stake = 0;
    }
  }

  // ── Parlay sizing — flat FRACTIONS of bankroll, never Kelly ────
  // Parlay probability estimates are too noisy to Kelly-size, so bet_3 and
  // bet_4 get small fixed percentages of the live bankroll. If that rounds
  // below the actionable minimum the parlay is dropped.
  const sizeParlay = (
    bet: { active?: boolean; stake?: string; skip_reason?: string | null } | undefined,
    pct: number,
  ) => {
    if (!bet) return;
    if (!bet.active) {
      bet.stake = "$0";
      return;
    }
    const s = Math.max(0, Math.round(bankroll * pct));
    if (s < BANKROLL_DEFAULTS.MIN_ACTIONABLE_STAKE) {
      bet.active = false;
      bet.stake = "$0";
      if (!bet.skip_reason)
        bet.skip_reason = "Bankroll too small for parlay allocation.";
    } else {
      bet.stake = `$${s}`;
    }
  };
  sizeParlay(result.bet_3, BANKROLL_DEFAULTS.SGP_STAKE_PCT);
  sizeParlay(result.bet_4, BANKROLL_DEFAULTS.JACKPOT_STAKE_PCT);

  // ── STRICT-SIGNAL REGIME → PAPER BETS ─────────────────────────
  // Every positive-EV bet is LOGGED, but real money only rides bets that pass
  // the strict gate. When strictMode is ON, an ACTIVE bet that fails
  // qualifiesForRealStake() becomes a $0 paper bet: fully tracked for CLV +
  // calibration, but excluded from exposure-cap math and bankroll settlement.
  // Paper bets keep their would-be Kelly result for the record.
  if (strictMode) {
    const paperize = (
      bet:
        | {
            active?: boolean;
            paper_bet?: boolean;
            paper_reason?: string;
            stake?: string;
          }
        | undefined,
      reason: string | null,
    ) => {
      if (!bet || !bet.active) return;
      if (reason) {
        bet.paper_bet = true;
        bet.paper_reason = reason;
        bet.stake = "$0 (PAPER)";
      } else {
        bet.paper_bet = false;
      }
    };
    paperize(result.bet_1, qualifyStraight(result.bet_1, result));
    paperize(result.bet_2, qualifyStraight(result.bet_2, result));
    paperize(result.bet_3, qualifySgp(result.bet_3, result));
    paperize(result.bet_4, qualifyJackpot(result.bet_4, result));
  } else {
    // Old behaviour: paper_bet false everywhere.
    for (const b of [result.bet_1, result.bet_2, result.bet_3, result.bet_4]) {
      if (b) b.paper_bet = false;
    }
  }

  // ── MATCH EXPOSURE CAP (replaces redistribution) ──────────────
  // Sum all active REAL stakes; if over the per-match cap, scale down in REVERSE
  // priority: drop bet_4, then bet_3, then shrink bet_2, never touching bet_1
  // (highest EV) unless it alone exceeds the cap (then clamp it). Paper bets are
  // $0 and excluded from this math.
  const cap = bankroll * BANKROLL_DEFAULTS.MAX_MATCH_EXPOSURE_PCT;
  const stakeOf = (
    bet: { active?: boolean; paper_bet?: boolean; stake?: string } | undefined,
  ): number =>
    bet && bet.active && !bet.paper_bet ? num(bet.stake) ?? 0 : 0;
  const sumActive = () =>
    stakeOf(result.bet_1) +
    stakeOf(result.bet_2) +
    stakeOf(result.bet_3) +
    stakeOf(result.bet_4);

  let exposureCapTriggered = false;
  if (sumActive() > cap) {
    exposureCapTriggered = true;

    if (sumActive() > cap && result.bet_4?.active) {
      result.bet_4.active = false;
      result.bet_4.stake = "$0";
      if (!result.bet_4.skip_reason)
        result.bet_4.skip_reason = "Dropped to satisfy match exposure cap.";
    }
    if (sumActive() > cap && result.bet_3?.active) {
      result.bet_3.active = false;
      result.bet_3.stake = "$0";
      if (!result.bet_3.skip_reason)
        result.bet_3.skip_reason = "Dropped to satisfy match exposure cap.";
    }
    if (sumActive() > cap && result.bet_2?.active) {
      const excess = sumActive() - cap;
      const newStake = Math.floor(stakeOf(result.bet_2) - excess);
      if (newStake < BANKROLL_DEFAULTS.MIN_ACTIONABLE_STAKE) {
        result.bet_2.active = false;
        result.bet_2.stake = "$0";
        if (result.bet_2.kelly_result)
          result.bet_2.kelly_result.recommended_stake = 0;
        if (!result.bet_2.skip_reason)
          result.bet_2.skip_reason = "Shrunk below minimum by match exposure cap.";
      } else {
        result.bet_2.stake = `$${newStake}`;
        if (result.bet_2.kelly_result)
          result.bet_2.kelly_result.recommended_stake = newStake;
      }
    }
    if (
      sumActive() > cap &&
      result.bet_1?.active &&
      stakeOf(result.bet_1) > cap
    ) {
      const clamped = Math.floor(cap);
      result.bet_1.stake = `$${clamped}`;
      if (result.bet_1.kelly_result)
        result.bet_1.kelly_result.recommended_stake = clamped;
    }
  }

  // ── TOTALS (bankroll-sized; replaces the old $50 unallocated math) ──
  const totalStaked = sumActive();
  result.total_staked = `$${totalStaked.toFixed(2)}`;
  result.match_exposure_pct = `${((totalStaked / bankroll) * 100).toFixed(1)}%`;
  result.match_exposure_cap_triggered = exposureCapTriggered;
  // Old UI bindings must never render stale $50 redistribution math.
  result.unallocated_stake = "N/A — bankroll sizing";

  // ── REAL vs PAPER counts ──────────────────────────────────────
  const allBets = [result.bet_1, result.bet_2, result.bet_3, result.bet_4];
  result.real_bet_count = allBets.filter(
    (b) => b && b.active && !b.paper_bet,
  ).length;
  result.paper_bet_count = allBets.filter(
    (b) => b && b.active && b.paper_bet,
  ).length;

  return result;
}

// ─────────────────────────────────────────────────────────────
// STRICT-SIGNAL QUALIFICATION — real-money gate
// ─────────────────────────────────────────────────────────────
/*
 * qualifiesForRealStake: returns null when a bet PASSES (rides real money),
 * else a human-readable string naming the FIRST failed condition (paper_reason).
 *
 * Shared failures (all bet types):
 *   - data_quality is THIN
 *   - ensemble_check.alignment is CONFLICT
 *   - bet.ev_confidence is LOW
 *   - lineup_dependency.level === "HIGH" and lineup_confirmed !== true
 */
function sharedFailure(
  bet: { ev_confidence?: string } | undefined,
  result: AnalysisResult,
): string | null {
  if (String(result.data_quality ?? "").toUpperCase() === "THIN") {
    return "Data quality THIN";
  }
  const alignment = (result as { ensemble_check?: { alignment?: string } })
    .ensemble_check?.alignment;
  if (String(alignment ?? "").toUpperCase() === "CONFLICT") {
    return "Ensemble alignment CONFLICT";
  }
  if (String(bet?.ev_confidence ?? "").toUpperCase() === "LOW") {
    return "EV confidence LOW";
  }
  const level = String(result.lineup_dependency?.level ?? "").toUpperCase();
  if (level === "HIGH" && result.lineup_confirmed !== true) {
    return "HIGH lineup dependency, lineup not confirmed";
  }
  return null;
}

function qualifyStraight(
  bet: StraightBet | undefined,
  result: AnalysisResult,
): string | null {
  if (!bet) return null;
  return sharedFailure(bet, result);
}

function qualifySgp(
  bet: SgpBet | undefined,
  result: AnalysisResult,
): string | null {
  if (!bet) return null;
  const shared = sharedFailure(bet as { ev_confidence?: string }, result);
  if (shared) return shared;
  // bet_3 additionally FAILS unless every leg has ev !== undefined and ≥ 0.
  const legs = bet.legs ?? [];
  const allLegsPositive = legs.every(
    (l: { ev?: number }) => l.ev !== undefined && (l.ev as number) >= 0,
  );
  if (!legs.length || !allLegsPositive) {
    return "A parlay leg has missing/negative EV";
  }
  return null;
}

function qualifyJackpot(
  bet: JackpotBet | undefined,
  result: AnalysisResult,
): string | null {
  if (!bet) return null;
  const shared = sharedFailure(bet as { ev_confidence?: string }, result);
  if (shared) return shared;
  // bet_4 additionally FAILS unless classification is JACKPOT / CLASS C.
  const cls = String(
    (result as { classification?: string }).classification ?? "",
  ).toUpperCase();
  const isJackpotClass = cls.includes("JACKPOT") || cls.includes("CLASS C");
  if (!isJackpotClass) {
    return "Not a JACKPOT / CLASS C classification";
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// Dead-rubber detection for group-stage fixtures in last-5 form
// ─────────────────────────────────────────────────────────────
/*
 * CALL SEQUENCE EXPLANATION:
 *
 * This dead-rubber check only matters for group-stage fixtures appearing in a
 * team's last-5 results (C4). Once the tournament moves past Round of 16, most
 * or all of a team's last-5 fixtures will be knockout matches where dead rubbers
 * cannot occur (every knockout match is won or the team is eliminated).
 *
 * This means S6 (standings) becomes an unnecessary call automatically as the
 * tournament progresses — no code change needed to "turn this off" later. The
 * trigger condition in the pipeline (any fixture in the group-stage window)
 * naturally stops firing once all five fixtures are knockout-stage.
 *
 * Call cost: at most ONE new call per match (all-groups standings, cached once
 * forever as "statsapi_all_standings_static" — the group stage is final and
 * immutable). This single call replaces the previous per-group standings calls.
 * By Quarter-Finals onward, expect zero additional calls.
 */

/*
 * WC2026 QUALIFICATION FORMAT (confirmed against the official FIFA 48-team
 * format and verified against the live TheStatsAPI standings response, which
 * returns 12 groups of 4 plus a 12-row cross-group third-place ranking table):
 *
 *   12 groups x 2 auto-advance        = 24 qualifiers
 *   + 8 best third-place finishers    =  8 qualifiers
 *   ----------------------------------------------------
 *   = 32 teams advancing to Round of 32
 *
 * Third-place teams are ranked across all 12 groups by points, then goal
 * difference, then goals scored; the best 8 advance alongside the 24 group
 * winners and runners-up. This is the critical difference from the pre-2026
 * 32-team format, where finishing 3rd in a group meant elimination.
 */
export const WC2026_QUALIFICATION = {
  groups_count: 12,
  top_per_group_auto_advance: 2,
  best_third_place_advancing: 8,
  // 12 groups x 2 = 24 auto qualifiers
  // + 8 best 3rd place = 32 total advancing to Round of 32
} as const;

/**
 * Determine whether a specific group-stage fixture was a "dead rubber" — a game
 * the opponent had no sporting incentive in because their advancement (or
 * elimination) was already mathematically settled before kickoff.
 *
 * FIX 6 — this function REQUIRES *pre-match* standings rows (the table as it
 * stood immediately before the fixture kicked off). Callers must reconstruct
 * them with buildPreMatchStandings(); passing FINAL standings makes clinchedTop2
 * true for every eventual top-2 finisher and corrupts the best-case third-place
 * maths. Because points only ever INCREASE, a best_case projection that already
 * falls below the pre-match cutoff remains a sound elimination proof.
 *
 * WC2026-aware: a team sitting 3rd in its group is NOT automatically eliminated.
 * It can still advance as one of the 8 best third-place finishers, so a 3rd-place
 * team's final group match is only a dead rubber when it is mathematically
 * eliminated from the cross-group third-place race as well.
 */
export const detectDeadRubber = (
  inputs: {
    fixture_matchday: number;
    fixture_date: string;
    opponent_team_id: string;
    opponent_group_standings: Array<{
      team_id: string;
      points: number;
      position: number;
      matches_played: number;
      goal_difference: number;
      goals_for: number;
    }>;
    all_groups_third_place_table: Array<{
      team_id: string;
      group_label: string;
      points: number;
      goal_difference: number;
      goals_for: number;
    }>;
    group_total_matchdays: number;
  },
): {
  is_dead_rubber: boolean;
  reason: string;
  // The actual numbers compared, so the boolean can be audited rather than
  // taken on trust. Populated as far as the logic progresses before returning.
  comparison: {
    is_final_matchday: boolean;
    fixture_matchday: number;
    group_total_matchdays: number;
    opponent: {
      team_id: string;
      position: number;
      points: number;
      matches_played: number;
      goal_difference: number;
      goals_for: number;
    } | null;
    own_group_rivals: Array<{
      team_id: string;
      position: number;
      points: number;
      matches_played: number;
      max_possible_points: number;
    }>;
    clinched_top2: boolean | null;
    third_place_check: {
      opponent_position: number;
      cutoff_rank: number;
      cutoff_third_place_points: number;
      best_case_opponent_points: number;
      mathematically_eliminated: boolean;
      third_place_field: Array<{
        team_id: string;
        group_label: string;
        points: number;
        goal_difference: number;
        goals_for: number;
      }>;
    } | null;
  };
} => {
  const opponent = inputs.opponent_group_standings.find(
    (s) => s.team_id === inputs.opponent_team_id,
  );

  const isFinalMatchday =
    inputs.fixture_matchday === inputs.group_total_matchdays;

  const baseComparison = {
    is_final_matchday: isFinalMatchday,
    fixture_matchday: inputs.fixture_matchday,
    group_total_matchdays: inputs.group_total_matchdays,
    opponent: opponent
      ? {
          team_id: opponent.team_id,
          position: opponent.position,
          points: opponent.points,
          matches_played: opponent.matches_played,
          goal_difference: opponent.goal_difference,
          goals_for: opponent.goals_for,
        }
      : null,
    own_group_rivals: [] as Array<{
      team_id: string;
      position: number;
      points: number;
      matches_played: number;
      max_possible_points: number;
    }>,
    clinched_top2: null as boolean | null,
    third_place_check: null as {
      opponent_position: number;
      cutoff_rank: number;
      cutoff_third_place_points: number;
      best_case_opponent_points: number;
      mathematically_eliminated: boolean;
      third_place_field: Array<{
        team_id: string;
        group_label: string;
        points: number;
        goal_difference: number;
        goals_for: number;
      }>;
    } | null,
  };

  if (!opponent) {
    return {
      is_dead_rubber: false,
      reason:
        "Opponent not found in group standings — default to not dead rubber.",
      comparison: baseComparison,
    };
  }

  // Only the FINAL group matchday can produce a dead rubber in a 3-match group
  // stage, since elimination or qualification is rarely mathematically certain
  // before the last round.
  if (!isFinalMatchday) {
    return {
      is_dead_rubber: false,
      reason:
        "Not the final group matchday — standings not yet settled.",
      comparison: baseComparison,
    };
  }

  // CASE A: Clinched top 2 in own group — guaranteed advancement regardless of
  // the 3rd-place race.
  const rivalsInGroup = inputs.opponent_group_standings.filter(
    (s) => s.team_id !== inputs.opponent_team_id,
  );
  baseComparison.own_group_rivals = rivalsInGroup.map((s) => ({
    team_id: s.team_id,
    position: s.position,
    points: s.points,
    matches_played: s.matches_played,
    max_possible_points:
      s.points + (inputs.group_total_matchdays - s.matches_played) * 3,
  }));
  const maxPossibleRivalPoints = baseComparison.own_group_rivals.map(
    (s) => s.max_possible_points,
  );
  const clinchedTop2 =
    opponent.position <= 2 &&
    maxPossibleRivalPoints.filter((p) => p > opponent.points).length <= 1;
  baseComparison.clinched_top2 = clinchedTop2;

  if (clinchedTop2) {
    return {
      is_dead_rubber: true,
      reason:
        "Opponent clinched top 2 in group before this fixture — guaranteed advancement.",
      comparison: baseComparison,
    };
  }

  // CASE B: Sitting 3rd or lower — must check the cross-group 3rd-place table,
  // not just the own group, since the 8 best 3rd-place teams advance under the
  // WC2026 48-team format.
  if (opponent.position >= 3) {
    // The opponent's own group is already accounted for by the top-2 logic
    // above; exclude its 3rd-place entry from the comparison field so we measure
    // the opponent against OTHER groups' third-place finishers.
    const opponentOwnGroup = inputs.all_groups_third_place_table.find(
      (x) => x.team_id === opponent.team_id,
    )?.group_label;

    const thirdPlaceField = inputs.all_groups_third_place_table.filter(
      (t) => t.group_label !== opponentOwnGroup,
    );

    // With the opponent's own group excluded, 7 other groups' third-place teams
    // are guaranteed ahead-or-equal slots; the cutoff is the (N-1)th best of the
    // remaining field that the opponent must out-rank to claim a top-N slot.
    const cutoffIndex = WC2026_QUALIFICATION.best_third_place_advancing - 1;
    const cutoffThirdPlacePoints =
      thirdPlaceField
        .map((t) => t.points)
        .sort((a, b) => b - a)[cutoffIndex] ?? 0;

    // Best case for the opponent: they win every remaining group match
    // (+3 each). When their group is already complete (matches_played ===
    // group_total_matchdays) there are zero matches left, so the best case is
    // simply their actual final points — adding a speculative +3 to a team with
    // no games remaining would artificially inflate eliminated teams to the
    // cutoff and flip a true elimination to a false "still alive" result.
    const opponentMatchesRemaining =
      inputs.group_total_matchdays - opponent.matches_played;
    const groupComplete = opponentMatchesRemaining <= 0;
    const bestCaseOpponentPoints = groupComplete
      ? opponent.points // no games left — use actual final points
      : opponent.points + opponentMatchesRemaining * 3; // best-case projection

    const mathematicallyEliminated =
      bestCaseOpponentPoints < cutoffThirdPlacePoints;

    baseComparison.third_place_check = {
      opponent_position: opponent.position,
      cutoff_rank: WC2026_QUALIFICATION.best_third_place_advancing,
      cutoff_third_place_points: cutoffThirdPlacePoints,
      best_case_opponent_points: bestCaseOpponentPoints,
      mathematically_eliminated: mathematicallyEliminated,
      third_place_field: thirdPlaceField
        .slice()
        .sort((a, b) => b.points - a.points)
        .map((t) => ({
          team_id: t.team_id,
          group_label: t.group_label,
          points: t.points,
          goal_difference: t.goal_difference,
          goals_for: t.goals_for,
        })),
    };

    if (mathematicallyEliminated) {
      return {
        is_dead_rubber: true,
        reason: `Opponent at position ${opponent.position} cannot reach the top ${WC2026_QUALIFICATION.best_third_place_advancing} third-place qualifiers even with a win — mathematically eliminated from advancement via any pathway.`,
        comparison: baseComparison,
      };
    }
  }

  return {
    is_dead_rubber: false,
    reason:
      "Final matchday, but advancement (via group position or 3rd-place cross-group ranking) was not yet mathematically settled — opponent had a meaningful stake in the result.",
    comparison: baseComparison,
  };
};


/**
 * Recency-weight a team's last-5 fixtures, discounting group-stage games (0.4x)
 * and dead-rubber group games even more heavily (0.2x), to produce adjusted
 * goals/shots averages that better reflect knockout-relevant form.
 */
export const applyDeadRubberDiscount = (
  fixtures: Array<{
    goals_scored: number;
    shots_on_target: number;
    is_dead_rubber: boolean;
    is_group_stage: boolean;
  }>,
): {
  adjusted_goals_avg: number;
  adjusted_shots_avg: number;
  dead_rubber_count: number;
  note: string;
} => {
  let totalGoals = 0;
  let totalShots = 0;
  let totalWeight = 0;
  let deadRubberCount = 0;

  fixtures.forEach((f) => {
    let weight = 1.0;
    if (f.is_group_stage) weight = 0.4;
    if (f.is_dead_rubber) {
      weight = 0.2;
      deadRubberCount++;
    }
    totalGoals += f.goals_scored * weight;
    totalShots += f.shots_on_target * weight;
    totalWeight += weight;
  });

  return {
    adjusted_goals_avg: totalWeight > 0 ? round(totalGoals / totalWeight) : 0,
    adjusted_shots_avg: totalWeight > 0 ? round(totalShots / totalWeight) : 0,
    dead_rubber_count: deadRubberCount,
    note:
      deadRubberCount > 0
        ? `${deadRubberCount} dead-rubber fixture(s) discounted to 0.2x weight — opponent had already secured or lost advancement before kickoff.`
        : "No dead-rubber fixtures detected in recent form.",
  };
};
