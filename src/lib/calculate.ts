/**
 * calculate.ts — application-side mathematics for the betting engine.
 *
 * Claude is instructed (see src/lib/systemPrompt.ts) to output RAW VARIABLES
 * only for every quantitative field, never the computed result. This module
 * takes Claude's raw JSON output and computes every derived figure:
 *
 *   1. Single-bet EV          (tier_1_anchor.ev)
 *   2. Parlay / jackpot EV     (tier_2_parlay.parlay_ev, tier_3_jackpot.jackpot_ev)
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
  ModelProbabilities,
  RestDisparity,
  TravelBurden,
} from "@/lib/analysisResult";
import { getVenueData } from "@/lib/venueData";

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
    return {
      adjusted_ev: round(inputs.raw_ev * 1.1),
      ev_confidence: "HIGH",
      note: `Stake odds ${Math.abs(gap_pct).toFixed(1)}% worse than Pinnacle, yet still EV positive. Stronger confirmation of genuine edge — model disagrees with the sharper market in your favor.`,
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
    // Drop any Claude-supplied ensemble adjustment, then inject the
    // single-source-of-truth value so it can never double-count or diverge.
    adjustments = adjustments.filter(
      (a) => !(a?.type ?? "").toLowerCase().includes("ensemble"),
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
  weights: DimensionWeights;
  call4_fixture_count: number;
  h2h_gate_passed: boolean;
  critical_absence_present: boolean;
  all_players_confirmed_fit: boolean;
}): DimensionWeightsValidation => {
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

  const mismatchFlags: string[] = [];
  (Object.keys(expected) as (keyof DimensionWeights)[]).forEach((k) => {
    if (Math.abs(inputs.weights[k] - expected[k]) > 2) {
      mismatchFlags.push(
        `${k}: Claude used ${inputs.weights[k]}, expected ${expected[k]} given data conditions.`,
      );
    }
  });

  const sum = Object.values(inputs.weights).reduce((a, b) => a + b, 0);
  const sumValid = Math.abs(sum - 100) < 1;
  if (!sumValid) {
    mismatchFlags.push(`Dimension weights sum to ${sum}, not 100.`);
  }

  return {
    weights: inputs.weights,
    expected_weights: expected,
    mismatch_flags: mismatchFlags,
    sum_valid: sumValid,
  };
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
export function calculateResults(rawOutput: unknown): AnalysisResult {
  if (!rawOutput || typeof rawOutput !== "object") {
    return (rawOutput ?? {}) as AnalysisResult;
  }

  const result = clone(rawOutput) as AnalysisResult;

  // 1 — Tier 1 anchor EV
  const t1 = result.tier_1_anchor;
  if (t1?.ev_inputs) {
    const ev = computeEv(
      t1.ev_inputs.model_probability,
      t1.ev_inputs.decimal_odds,
    );
    if (ev !== undefined) {
      t1.ev = ev;
      if (t1.model_probability === undefined)
        t1.model_probability = num(t1.ev_inputs.model_probability);
      if (t1.odds === undefined) t1.odds = num(t1.ev_inputs.decimal_odds);
    }
  }

  // 1b — Stake-anchoring bias correction for the Tier 1 anchor.
  if (t1?.ev !== undefined && t1.odds !== undefined) {
    const pinnacleOdds = num(t1.pinnacle_odds) ?? null;
    const adjustment = adjustEVForPinnacleGap({
      raw_ev: t1.ev,
      stake_odds: t1.odds,
      pinnacle_odds: pinnacleOdds,
    });

    t1.raw_ev = t1.ev;
    t1.ev = adjustment.adjusted_ev;
    t1.ev_confidence = adjustment.ev_confidence;
    t1.pinnacle_check_note = adjustment.note;

    // Re-apply EV rating thresholds to the ADJUSTED ev, not raw.
    t1.ev_rating =
      adjustment.adjusted_ev >= 0.08
        ? "STRONG"
        : adjustment.adjusted_ev >= 0.05
          ? "MARGINAL"
          : "SKIP";
    t1.active = adjustment.adjusted_ev >= 0.05;
  }

  // 2 — Parlay EV
  const t2 = result.tier_2_parlay;
  if (t2?.parlay_ev_inputs) {
    const ev = computeEv(
      t2.parlay_ev_inputs.p_final,
      t2.parlay_ev_inputs.effective_sgp_price,
    );
    if (ev !== undefined) t2.parlay_ev = ev;
  }

  // 2b — Stake-anchoring bias correction for any Tier 2 leg that has a
  // corresponding Pinnacle market available.
  if (Array.isArray(t2?.legs)) {
    for (const leg of t2.legs) {
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

  // 2 — Jackpot EV
  const t3 = result.tier_3_jackpot;
  if (t3?.jackpot_ev_inputs) {
    const ev = computeEv(
      t3.jackpot_ev_inputs.p_final,
      t3.jackpot_ev_inputs.combined_odds,
    );
    if (ev !== undefined) t3.jackpot_ev = ev;
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
    if (validation.mismatch_flags.length > 0) {
      result.key_risk_flag =
        (result.key_risk_flag || "") +
        " [WEIGHT VALIDATION: " +
        validation.mismatch_flags.join(" ") +
        "]";
    }
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

  return result;
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
 * This means S6 (standings) and the groups lookup become unnecessary calls
 * automatically as the tournament progresses — no code change needed to "turn
 * this off" later. The trigger condition in the pipeline (any fixture in the
 * group-stage window) naturally stops firing once all five fixtures are
 * knockout-stage.
 *
 * Call cost: at most 2 new calls per match (one groups lookup, cached forever;
 * one standings lookup per team's group, cached per group per day) and only
 * during the early knockout rounds where group-stage fixtures still appear in
 * the last-5 window. By Quarter-Finals onward, expect zero additional calls.
 */

/**
 * Determine whether a specific group-stage fixture was a "dead rubber" — a game
 * the opponent had no sporting incentive in because their advancement (or
 * elimination) was already mathematically settled before kickoff.
 */
export const detectDeadRubber = (
  inputs: {
    fixture_matchday: number;
    fixture_date: string;
    opponent_team_id: string;
    group_standings: Array<{
      team_id: string;
      points: number;
      position: number;
      matches_played: number;
    }>;
    group_total_matchdays: number;
  },
): {
  is_dead_rubber: boolean;
  reason: string;
} => {
  const opponent = inputs.group_standings.find(
    (s) => s.team_id === inputs.opponent_team_id,
  );

  if (!opponent) {
    return {
      is_dead_rubber: false,
      reason:
        "Opponent not found in group standings — cannot determine, default to not dead rubber.",
    };
  }

  // Only the FINAL group matchday can produce a dead rubber in a 3-match group
  // stage, since elimination or qualification is rarely mathematically certain
  // before the last round.
  const isFinalMatchday =
    inputs.fixture_matchday === inputs.group_total_matchdays;

  if (!isFinalMatchday) {
    return {
      is_dead_rubber: false,
      reason:
        "Not the final group matchday — standings not yet mathematically settled.",
    };
  }

  // Top positions advance (varies by format, WC2026 top 2 per group of 4 plus
  // some 3rd-place teams advance — use a conservative top-2-locked threshold).
  const pointsAfterThisMatch = opponent.points;
  const maxPossiblePointsForRivals = inputs.group_standings
    .filter((s) => s.team_id !== inputs.opponent_team_id)
    .map(
      (s) =>
        s.points + (inputs.group_total_matchdays - s.matches_played) * 3,
    );

  const clinchedTop2 =
    opponent.position <= 2 &&
    maxPossiblePointsForRivals.filter((p) => p > pointsAfterThisMatch).length <=
      1;

  const mathematicallyEliminated =
    opponent.position >= 3 &&
    maxPossiblePointsForRivals.filter((p) => p <= pointsAfterThisMatch)
      .length === 0;

  if (clinchedTop2 || mathematicallyEliminated) {
    return {
      is_dead_rubber: true,
      reason: clinchedTop2
        ? "Opponent had already clinched advancement before this fixture."
        : "Opponent was already mathematically eliminated before this fixture.",
    };
  }

  return {
    is_dead_rubber: false,
    reason:
      "Final matchday but standings were not yet mathematically settled — both sides had something to play for.",
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
