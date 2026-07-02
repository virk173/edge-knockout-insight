/**
 * normalizeAnalysisResult.ts — coercing Zod normalization for the Claude
 * analysis JSON.
 *
 * Claude is an LLM: it can omit whole nested objects/arrays run to run, and
 * older cached results (resultCache.ts, backtest log) were saved under looser
 * shapes. Rather than sprinkle optional chaining across every display
 * component, this module guarantees a consistent structure ONCE — right after
 * JSON.parse / calculateResults and again when a cached result is re-hydrated.
 *
 * Design rules:
 *  - Parsing NEVER throws. Every declared field carries a `.catch()`/`.default()`
 *    so a wrong type or a missing field degrades to a safe default instead of
 *    rejecting the whole payload.
 *  - Only the CONTAINERS the UI can safely stop null-checking are declared
 *    (confidence_scores, ensemble_check, player_intelligence, bet_1..bet_4,
 *    markets_evaluated, markets_rejected) plus the arrays nested inside them.
 *    Everything else flows through untouched via `.passthrough()`, so
 *    app-computed fields (kelly_result, model_probabilities, log_entry,
 *    probability_derivation, context adjustments, …) are preserved exactly.
 *  - Presence-driven sections (tactical_analysis, altitude_adjustment,
 *    rest_disparity, travel_burden, analyst_note, key_risk_flag) are left
 *    OPTIONAL on purpose — the UI hides them when absent, so defaulting them to
 *    empty objects would change rendering behavior.
 */

import { z } from "zod";
import type { AnalysisResult } from "./analysisResult";

// A loose object that keeps every key it is given.
const passthroughObject = z.object({}).passthrough();

// An array that degrades to [] on a wrong type or a missing value.
function safeArray<T extends z.ZodTypeAny>(item: T) {
  return z.array(item).catch([]).default([]);
}

// ── Guaranteed containers ─────────────────────────────────────
const confidenceScoresSchema = z
  .object({ adjustments: safeArray(passthroughObject) })
  .passthrough()
  .catch({ adjustments: [] })
  .default({ adjustments: [] });

const ensembleCheckSchema = z
  .object({})
  .passthrough()
  .catch({})
  .default({});

const playerIntelligenceSchema = z
  .object({ absences: safeArray(passthroughObject) })
  .passthrough()
  .catch({ absences: [] })
  .default({ absences: [] });

const straightBetSchema = z
  .object({})
  .passthrough()
  .catch({})
  .default({});

const sgpBetSchema = z
  .object({ legs: safeArray(passthroughObject) })
  .passthrough()
  .catch({ legs: [] })
  .default({ legs: [] });

const jackpotBetSchema = z
  .object({ legs: safeArray(passthroughObject) })
  .passthrough()
  .catch({ legs: [] })
  .default({ legs: [] });

const analysisResultSchema = z
  .object({
    confidence_scores: confidenceScoresSchema,
    ensemble_check: ensembleCheckSchema,
    player_intelligence: playerIntelligenceSchema,
    bet_1: straightBetSchema,
    bet_2: straightBetSchema,
    bet_3: sgpBetSchema,
    bet_4: jackpotBetSchema,
    markets_evaluated: safeArray(z.string().catch("")),
    markets_rejected: safeArray(passthroughObject),
  })
  .passthrough();

/**
 * Normalize an arbitrary Claude / cached payload into a consistently-shaped
 * AnalysisResult. Guaranteed containers always exist; every other field is
 * preserved as-is. Never throws.
 */
export function normalizeAnalysisResult(raw: unknown): AnalysisResult {
  if (!raw || typeof raw !== "object") {
    return analysisResultSchema.parse({}) as AnalysisResult;
  }
  const parsed = analysisResultSchema.safeParse(raw);
  if (parsed.success) return parsed.data as AnalysisResult;
  // Belt-and-braces: every declared field has a .catch(), so safeParse should
  // always succeed. If it somehow does not, merge the guaranteed skeleton onto
  // the raw object instead of throwing.
  return {
    ...(raw as Record<string, unknown>),
    ...(analysisResultSchema.parse({}) as Record<string, unknown>),
  } as unknown as AnalysisResult;
}
