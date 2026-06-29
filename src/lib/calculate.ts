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
  AnalysisResult,
  ConfidenceAdjustment,
} from "@/lib/analysisResult";

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
// 4 — Confidence score
//   post_adj = raw + Σ(deltas)
//   if post_adj > 75:  final = 75 + (post_adj − 75) × 0.40
//   else:              final = post_adj
// ─────────────────────────────────────────────────────────────
export function computeConfidence(inputs?: {
  dimension_weighted_raw?: number;
  adjustments?: ConfidenceAdjustment[];
}): { post_adjustment: number; final_confidence: number; bayesian_applied: boolean } | undefined {
  if (!inputs) return undefined;
  const raw = num(inputs.dimension_weighted_raw);
  if (raw === undefined) return undefined;
  const sum = (inputs.adjustments ?? []).reduce(
    (acc, a) => acc + (num(a?.delta) ?? 0),
    0,
  );
  const postAdj = raw + sum;
  const bayesian = postAdj > 75;
  const final = bayesian ? 75 + (postAdj - 75) * 0.4 : postAdj;
  return {
    post_adjustment: round(postAdj, 1),
    final_confidence: round(final, 1),
    bayesian_applied: bayesian,
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
  const enriched = outcomes
    .map((o) => {
      const odds = num(o?.odds);
      return odds && odds > 0
        ? { name: o?.name, odds, raw_implied: 1 / odds }
        : null;
    })
    .filter((o): o is { name?: string; odds: number; raw_implied: number } => o !== null);
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

  // 2 — Parlay EV
  const t2 = result.tier_2_parlay;
  if (t2?.parlay_ev_inputs) {
    const ev = computeEv(
      t2.parlay_ev_inputs.p_final,
      t2.parlay_ev_inputs.effective_sgp_price,
    );
    if (ev !== undefined) t2.parlay_ev = ev;
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

  // 4 — Confidence score
  const cs = result.confidence_scores;
  if (cs?.confidence_inputs) {
    const conf = computeConfidence(cs.confidence_inputs);
    if (conf !== undefined) {
      cs.dimension_weighted_raw =
        num(cs.confidence_inputs.dimension_weighted_raw) ??
        cs.dimension_weighted_raw;
      cs.adjustments = cs.confidence_inputs.adjustments ?? cs.adjustments;
      cs.post_adjustment = conf.post_adjustment;
      cs.final_confidence = conf.final_confidence;
      cs.bayesian_applied = conf.bayesian_applied;
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

  return result;
}
