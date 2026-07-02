/**
 * Type definitions for the Claude analysis JSON output (V3.0 schema).
 * All fields are optional and tolerant — Claude may omit or shorten fields,
 * so the UI must render defensively.
 */


// ─────────────────────────────────────────────────────────────
// Raw-variable inputs emitted by Claude (computed in app code).
// See src/lib/calculate.ts — calculateResults() turns these into
// the *_computed numbers the dashboard renders.
// ─────────────────────────────────────────────────────────────
export interface EvInputs {
  model_probability?: number;
  decimal_odds?: number;
}

export interface KellyInputs {
  ev?: number;
  decimal_odds?: number;
  bankroll?: number;
  fraction?: number;
  floor?: number;
  ceiling?: number;
}

export interface KellyResult {
  full_kelly_pct: number;
  fractional_kelly_pct: number;
  raw_stake: number;
  recommended_stake: number;
  capped: boolean;
  skipped_too_small: boolean;
  reasoning: string;
}

export interface ParlayEvInputs {
  // Correct inputs: parlay_ev = p_joint × stake_sgp − 1.
  p_joint?: number;
  stake_sgp?: number;
  hold_rate?: number; // diagnostic only — the SGP margin, NOT used in the EV math
  // Legacy (deprecated) double-vig inputs, retained so old cached results render.
  p_final?: number;
  effective_sgp_price?: number;
}

export interface JackpotEvInputs {
  p_final?: number;
  combined_odds?: number;
}

export interface GapScoreInputs {
  actual_goals?: number;
  actual_assists?: number;
  shots_pg_delta?: number;
  keypasses_pg_delta?: number;
  set_piece_weight?: number;
}

export interface MultiplierInputs {
  gap_multiplier?: number;
  depth_multiplier?: number;
}

export interface ConfidenceInputs {
  dimension_weighted_raw?: number;
  adjustments?: ConfidenceAdjustment[];
}

export interface OverroundOutcome {
  name?: string;
  odds?: number;
  raw_implied?: number;
  true_implied?: number;
}

export interface OverroundInputs {
  outcomes?: OverroundOutcome[];
}

export interface EnsembleCheck {
  market?: string;
  signal_1_model?: number;
  signal_2_poisson?: number;
  signal_3_historical?: number;
  alignment?: string; // "TRIPLE ALIGNED" | "MAJORITY" | "CONFLICT"
  confidence_impact?: string;
  note?: string;
  max_pairwise_diff?: number;
}

export interface ModelProbabilities {
  home: number;
  draw: number;
  away: number;
  was_normalized?: boolean;
  raw_sum?: number;
}

export interface DimensionWeights {
  D1: number;
  D2: number;
  D3: number;
  D4: number;
  D5: number;
  D6: number;
}

export interface DimensionWeightsValidation {
  weights: DimensionWeights | null;
  expected_weights: DimensionWeights | null;
  mismatch_flags: string[];
  sum_valid: boolean;
  validation_ran?: boolean;
}

export interface ConfidenceAdjustment {
  type?: string;
  delta?: number;
}

export interface DimensionBreakdownItem {
  dimension?: string;
  label?: string;
  weight?: number;
  score?: number;
}

export interface ConfidenceScores {
  // Raw variables from Claude (preferred source of truth).
  confidence_inputs?: ConfidenceInputs;
  dimension_weighted_raw?: number;
  // Guaranteed by normalizeAnalysisResult() — always an array (may be empty).
  adjustments: ConfidenceAdjustment[];
  post_adjustment?: number;
  bayesian_applied?: boolean;
  bayesian_formula?: string;
  final_confidence?: number;
  dimension_breakdown?:
    | DimensionBreakdownItem[]
    | Record<string, number | DimensionBreakdownItem>;
}

export interface TacticalAnalysis {
  formation_home?: string;
  formation_away?: string;
  formation_home_assumed?: string;
  formation_away_assumed?: string;
  formation_changed?: boolean;
  press_matchup_type?: string;
  expected_corners_range?: string;
  expected_cards_range?: string;
  goals_model_direction?: string; // "OVER" | "UNDER" | "NEUTRAL"
  formation_change_impact?: string;
  call4_fixture_count?: number;
}

export interface Absence {
  player?: string;
  team?: string;
  // Raw variables from Claude (preferred source of truth).
  gap_score_inputs?: GapScoreInputs;
  multiplier_inputs?: MultiplierInputs;
  gap_score?: number;
  gap_calculation?: string;
  classification?: string; // "CRITICAL" | "SIGNIFICANT" | ...
  replacement?: string;
  replacement_profile?: string;
  depth_rating?: string;
  stacked_multiplier?: number;
  adjustment_note?: string;
}

export interface PlayerIntelligence {
  // Guaranteed by normalizeAnalysisResult() — always an array (may be empty).
  absences: Absence[];
  players_confirmed_fit?: string[];
  suspension_served_eligible?: string[];
}

export interface TierLeg {
  leg_number?: number;
  market?: string;
  selection?: string;
  odds?: number;
  model_probability?: number;
  correlation_logic?: string;
  stake_label?: string;
  // Pinnacle-gap EV adjustment (computed app-side when a leg has both a
  // model_probability and a Pinnacle reference price).
  pinnacle_odds?: number | null;
  raw_ev?: number;
  ev?: number;
  ev_confidence?: "HIGH" | "MEDIUM" | "LOW";
  pinnacle_check_note?: string;
}

export interface TierReturns {
  potential_return_raw?: string;
  potential_return_realistic?: string;
  basis_note?: string;
}

export interface SgpValidation {
  independent_price?: number;
  stake_sgp_price?: number;
  sgp_ratio?: number;
  hold_rate?: number;
  status?: string;
}

// ─────────────────────────────────────────────────────────────
// 4-bet architecture (Section 7). bet_1 and bet_2 are Kelly-sized
// straight bets; bet_3 is the 3-leg SGP; bet_4 is the jackpot.
// ─────────────────────────────────────────────────────────────
export interface StraightBet {
  active?: boolean;
  skip_reason?: string | null;
  market?: string;
  selection?: string;
  bet_type?: string; // "Straight Bet"
  stake?: string; // Kelly-computed by app from kelly_inputs
  odds?: number;
  model_probability?: number;
  market_group?: string; // A | B | C | D | E
  stake_label?: string;
  source_calls?: string[];
  // Raw variables from Claude (preferred source of truth for EV).
  ev_inputs?: EvInputs;
  books_true_implied?: number;
  ev?: number;
  ev_rating?: string;
  // Kelly stake sizing (computed app-side, see calculate.ts).
  kelly_inputs?: KellyInputs;
  kelly_result?: KellyResult;
  // Pinnacle-gap EV adjustment (computed app-side, see calculate.ts).
  pinnacle_odds?: number | null;
  raw_ev?: number;
  ev_confidence?: "HIGH" | "MEDIUM" | "LOW";
  pinnacle_check_note?: string;
  reasoning?: string;
  // Calibration (computed app-side, see calibration.ts / calculate.ts).
  model_probability_raw?: number;
  calibration_note?: string;
  // Strict-signal / paper-bet mode (computed app-side, see calculate.ts).
  paper_bet?: boolean;
  paper_reason?: string;
}

export interface SgpBet {
  active?: boolean;
  skip_reason?: string | null;
  bet_type?: string; // "Same Game Parlay (3-Leg Accumulator)"
  stake?: string;
  legs: TierLeg[]; // guaranteed by normalizeAnalysisResult() (may be empty)
  p_independent?: number;
  correlation_factor?: number;
  p_joint?: number;
  stake_sgp?: number;
  combined_odds_sgp?: number;
  sgp_validation?: SgpValidation;
  returns?: TierReturns;
  // Raw variables from Claude (preferred source of truth for EV).
  parlay_ev_inputs?: ParlayEvInputs;
  parlay_ev?: number;
  ev_rating?: string;
  reasoning?: string;
  // Strict-signal / paper-bet mode (computed app-side, see calculate.ts).
  paper_bet?: boolean;
  paper_reason?: string;
}

export interface JackpotBet {
  active?: boolean;
  skip_reason?: string | null;
  bet_type?: string; // "Jackpot Accumulator (4-5 Leg Parlay)"
  stake?: string;
  legs?: TierLeg[];
  combined_odds?: number;
  returns?: TierReturns;
  // Raw variables from Claude (preferred source of truth for EV).
  jackpot_ev_inputs?: JackpotEvInputs;
  jackpot_ev?: number;
  ev_rating?: string;
  class_c_signals?: string[];
  // Strict-signal / paper-bet mode (computed app-side, see calculate.ts).
  paper_bet?: boolean;
  paper_reason?: string;
}


export interface MarketRejected {
  market?: string;
  ev?: number;
  reason?: string;
}

// ─────────────────────────────────────────────────────────────
// Contextual factors (computed in app code from context_inputs +
// static venue data). See src/lib/calculate.ts.
// ─────────────────────────────────────────────────────────────
export interface ContextInputs {
  venue_name?: string;
  home_last_fixture_date?: string;
  away_last_fixture_date?: string;
  home_avg_altitude?: number;
  away_avg_altitude?: number;
  home_last_venue_tz?: number;
  away_last_venue_tz?: number;
}

export interface AltitudeAdjustment {
  applies_to: "home" | "away" | null;
  pressing_multiplier: number;
  et_probability_delta: number;
  note: string;
}

export interface RestDisparity {
  rest_hours_home: number;
  rest_hours_away: number;
  disparity_hours: number;
  fatigued_team: "home" | "away" | null;
  goals_multiplier: number;
  upset_probability_delta: number;
  note: string;
}

export interface TravelBurden {
  home_timezone_shift: number;
  away_timezone_shift: number;
  disparity: number;
  burdened_team: "home" | "away" | null;
  pressing_multiplier: number;
  note: string;
}

export interface AnalysisResult {
  match?: string;
  kickoff_UTC?: string;
  kickoff_local?: string;
  round?: string;
  classification?: string; // "COMPETITIVE" | "HEAVY MISMATCH" | "JACKPOT"
  data_quality?: string; // "FULL" | "PARTIAL" | "THIN"
  pinnacle_available?: boolean;
  overround_pinnacle?: number | null;
  // Raw variables from Claude (preferred source of truth for overround).
  overround_inputs?: OverroundInputs;
  overround_stake?: number;
  // Guaranteed containers — normalizeAnalysisResult() always populates these,
  // so display components can read them without optional chaining.
  ensemble_check: EnsembleCheck;
  confidence_scores: ConfidenceScores;
  tactical_analysis?: TacticalAnalysis;
  player_intelligence: PlayerIntelligence;
  bet_1: StraightBet;
  bet_2: StraightBet;
  bet_3: SgpBet;
  bet_4: JackpotBet;
  total_staked?: string;
  unallocated_stake?: string;
  match_exposure_pct?: string;
  match_exposure_cap_triggered?: boolean;
  bankroll_at_analysis?: number;
  // Strict-signal regime (computed app-side, see calculate.ts).
  real_bet_count?: number;
  paper_bet_count?: number;
  // Lineup dependency signals used by the strict qualification gate. Claude may
  // emit lineup_dependency.level; lineup_confirmed is set by the pipeline/UI.
  lineup_dependency?: { level?: "HIGH" | "MEDIUM" | "LOW" | string };
  lineup_confirmed?: boolean;
  markets_evaluated?: string[];
  markets_rejected?: MarketRejected[];
  key_risk_flag?: string;
  // Validated / normalized fields (computed app-side, see calculate.ts).
  model_probabilities?: ModelProbabilities;
  data_quality_flags?: string[];
  dimension_weights?: DimensionWeights;
  dimension_weights_validation?: DimensionWeightsValidation;
  analyst_note?: string;
  // Contextual factor inputs from Claude + computed adjustments (app code).
  context_inputs?: ContextInputs;
  altitude_adjustment?: AltitudeAdjustment;
  rest_disparity?: RestDisparity;
  travel_burden?: TravelBurden;
  log_entry?: import("@/lib/backtestLog").RawLogEntry;
}

/** Parse a gap percentage string like "+3.5%" into a number (3.5). */
export function parseGapPct(gap?: string): number {
  if (!gap) return NaN;
  const m = gap.replace(/[^0-9.+-]/g, "");
  const n = Number.parseFloat(m);
  return Number.isFinite(n) ? n : NaN;
}

/** Format an EV decimal as a signed string, e.g. 0.101 -> "+0.101". */
export function formatEv(ev?: number): string {
  if (typeof ev !== "number" || !Number.isFinite(ev)) return "—";
  return `${ev >= 0 ? "+" : ""}${ev.toFixed(3)}`;
}

/** Normalize dimension_breakdown into a flat array for rendering. */
export function normalizeDimensions(
  db: ConfidenceScores["dimension_breakdown"],
): DimensionBreakdownItem[] {
  if (!db) return [];
  if (Array.isArray(db)) return db;
  return Object.entries(db).map(([key, value]) => {
    if (typeof value === "number") {
      return { label: key, score: value };
    }
    return { label: value.label ?? value.dimension ?? key, ...value };
  });
}
