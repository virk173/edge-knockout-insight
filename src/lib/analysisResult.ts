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

export interface ParlayEvInputs {
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
  alignment?: string; // "TRIPLE" | "MAJORITY" | "CONFLICT"
  confidence_impact?: string;
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
  adjustments?: ConfidenceAdjustment[];
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
  absences?: Absence[];
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
}

export interface Tier1Anchor {
  active?: boolean;
  skip_reason?: string | null;
  market?: string;
  selection?: string;
  stake?: string;
  odds?: number;
  model_probability?: number;
  // Raw variables from Claude (preferred source of truth for EV).
  ev_inputs?: EvInputs;
  books_true_implied?: number;
  ev?: number;
  ev_rating?: string;

  reasoning?: string;
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

export interface Tier2Parlay {
  active?: boolean;
  skip_reason?: string | null;
  stake?: string;
  stake_boost_pct?: number;
  sgp_validation?: SgpValidation;
  legs?: TierLeg[];
  returns?: TierReturns;
  // Raw variables from Claude (preferred source of truth for EV).
  parlay_ev_inputs?: ParlayEvInputs;
  parlay_ev?: number;
  ev_rating?: string;
  reasoning?: string;
}

export interface Tier3Jackpot {
  active?: boolean;
  skip_reason?: string | null;
  stake?: string;
  stake_boost_pct?: number;
  legs?: TierLeg[];
  combined_odds?: number;
  returns?: TierReturns;
  // Raw variables from Claude (preferred source of truth for EV).
  jackpot_ev_inputs?: JackpotEvInputs;
  jackpot_ev?: number;
  class_c_signals?: string[];
}

export interface MarketRejected {
  market?: string;
  ev?: number;
  reason?: string;
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
  ensemble_check?: EnsembleCheck;
  confidence_scores?: ConfidenceScores;
  tactical_analysis?: TacticalAnalysis;
  player_intelligence?: PlayerIntelligence;
  tier_1_anchor?: Tier1Anchor;
  tier_2_parlay?: Tier2Parlay;
  tier_3_jackpot?: Tier3Jackpot;
  total_staked?: string;
  unallocated_stake?: string;
  markets_evaluated?: string[];
  markets_rejected?: MarketRejected[];
  key_risk_flag?: string;
  analyst_note?: string;
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
