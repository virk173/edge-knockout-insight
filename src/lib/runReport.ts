import type { CollectionResult, CallResult, LineupState } from "@/lib/analyse";
import type {
  AnalysisResult,
  Absence,
  ConfidenceAdjustment,
  TierLeg,
} from "@/lib/analysisResult";

// The Section-3 "Copy Run Report" flattens the entire current match analysis
// into one plain-text, clipboard-friendly block. Everything is defensive:
// any missing value renders as "N/A" — never `undefined`/`null`.

/** The per-call collection map produced by the data pipeline (state.collection). */
export type CallStatusMap = CollectionResult | null;

/** The Claude output enriched with app-side computed numbers (calculate.ts). */
export type EnrichedResult = AnalysisResult | null | undefined;

const NA = "N/A";
const RULE = "─────────────────────────────────";

// Logical call keys grouped by upstream API. Mirrors the debug-report counting
// in analyse.ts (API-Football = 8 counted calls, TheStatsAPI = 7).
const AF_KEYS = ["3", "4-1", "4-2", "4-3", "5", "8", "9A", "10"];
const SA_KEYS = ["S0", "2A", "2B", "6", "6B", "9B", "7"];

function na(v: unknown): string {
  if (v === undefined || v === null) return NA;
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : NA;
  const s = String(v).trim();
  return s.length ? s : NA;
}

function num(v: unknown, digits?: number): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return NA;
  return typeof digits === "number" ? v.toFixed(digits) : String(v);
}

function signed(v: unknown, digits = 3): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return NA;
  return `${v >= 0 ? "+" : ""}${v.toFixed(digits)}`;
}

function lineupText(state: LineupState | undefined, resolved: boolean): string {
  switch (state) {
    case "POPULATED":
      return "CONFIRMED";
    case "PROPAGATING":
      return resolved ? "PROPAGATING (fallback: API-Football)" : "PROPAGATING";
    case "NOT_ANNOUNCED":
      return resolved ? "PENDING (fallback: API-Football)" : "PENDING";
    default:
      return NA;
  }
}

function statusList(cr: Record<string, CallResult>, status: string): string {
  const hits = Object.values(cr)
    .filter((c) => c?.status === status)
    .map((c) => c?.label || c?.key)
    .filter(Boolean);
  return hits.length ? hits.join(", ") : "none";
}

function countSucceeded(cr: Record<string, CallResult>, keys: string[]): number {
  return keys.filter((k) => cr[k]?.status === "SUCCESS").length;
}

function fmtAdjustments(adj: ConfidenceAdjustment[] | undefined): string {
  if (!Array.isArray(adj) || adj.length === 0) return NA;
  return adj
    .map((a) => `${na(a?.type)}: ${signed(a?.delta)}`)
    .join(", ");
}

function fmtAbsence(a: Absence): string {
  const goals = num(a?.gap_score_inputs?.actual_goals);
  const assists = num(a?.gap_score_inputs?.actual_assists);
  return [
    `  ${na(a?.player)} (${na(a?.team)}) ${na(a?.classification)}`,
    `    goals:${goals} assists:${assists}`,
    `    replacement: ${na(a?.replacement)}`,
  ].join("\n");
}

function fmtLeg(leg: TierLeg, i: number): string {
  return `  Leg ${leg?.leg_number ?? i + 1}: ${na(leg?.selection)} @ ${num(leg?.odds)}`;
}

export function generateRunReport(
  match: string,
  round: string,
  kickoff: string,
  callStatuses: CallStatusMap,
  analysisResult: EnrichedResult,
  claudeRaw: string,
  lastRunAt: Date,
): string {
  const cr = callStatuses?.callResults ?? {};
  const r = analysisResult ?? {};

  const L: string[] = [];
  const push = (s = "") => L.push(s);

  // ── Header ──────────────────────────────────────────────
  push("EDGE RUN REPORT");
  push(`${na(match)} — ${na(round)} — ${na(kickoff)}`);
  push(
    `Run at: ${
      lastRunAt instanceof Date && !Number.isNaN(lastRunAt.getTime())
        ? lastRunAt.toISOString()
        : NA
    }`,
  );
  push(RULE);

  // ── Pipeline ────────────────────────────────────────────
  push("PIPELINE");
  push(`API-Football: ${countSucceeded(cr, AF_KEYS)}/8 succeeded`);
  push(`TheStatsAPI: ${countSucceeded(cr, SA_KEYS)}/7 succeeded`);
  push(`Failed: ${statusList(cr, "FAILED")}`);
  push(`Empty: ${statusList(cr, "EMPTY")}`);
  push(
    `Lineups: ${lineupText(
      callStatuses?.lineupState,
      callStatuses?.lineupResolved ?? false,
    )}`,
  );
  push(`Data quality: ${na(r.data_quality)}`);
  push(
    `Dead-rubber discounted: ${
      typeof callStatuses?.deadRubberFlagged === "number"
        ? callStatuses.deadRubberFlagged
        : 0
    } fixtures`,
  );
  push();

  // ── Confidence ──────────────────────────────────────────
  const cs = r.confidence_scores ?? {};
  push("CONFIDENCE");
  push(
    `Raw: ${na(
      cs.dimension_weighted_raw ?? cs.confidence_inputs?.dimension_weighted_raw,
    )}`,
  );
  push(
    `Adjustments: ${fmtAdjustments(
      cs.adjustments ?? cs.confidence_inputs?.adjustments,
    )}`,
  );
  push(`Final: ${na(cs.final_confidence)}`);
  push(`Ensemble: ${na(r.ensemble_check?.alignment)}`);
  push(`Pinnacle: ${r.pinnacle_available ? "YES" : "NO"}`);
  push();

  // ── Dimension weights ───────────────────────────────────
  const dw = r.dimension_weights;
  const dwv = r.dimension_weights_validation;
  push("DIMENSION WEIGHTS");
  if (dw) {
    push(
      `D1:${num(dw.D1)} D2:${num(dw.D2)} D3:${num(dw.D3)} D4:${num(dw.D4)}`,
    );
    const sum = [dw.D1, dw.D2, dw.D3, dw.D4, dw.D5, dw.D6].reduce(
      (acc, n) => acc + (typeof n === "number" ? n : 0),
      0,
    );
    push(`D5:${num(dw.D5)} D6:${num(dw.D6)} Sum:${num(sum, 2)}`);
  } else {
    push(`D1:${NA} D2:${NA} D3:${NA} D4:${NA}`);
    push(`D5:${NA} D6:${NA} Sum:${NA}`);
  }
  if (dwv?.sum_valid) {
    push("VALID");
  } else {
    const reason =
      dwv?.mismatch_flags && dwv.mismatch_flags.length
        ? dwv.mismatch_flags.join("; ")
        : dwv?.validation_ran === false
          ? "validation did not run"
          : "sum invalid";
    push(`MISMATCH — ${reason}`);
  }
  push();

  // ── Absences ────────────────────────────────────────────
  push("ABSENCES");
  const absences = r.player_intelligence?.absences ?? [];
  if (absences.length) {
    for (const a of absences) push(fmtAbsence(a));
  } else {
    push("  none");
  }
  const onNotice = r.player_intelligence?.suspension_served_eligible;
  push(
    `On notice: ${
      Array.isArray(onNotice) && onNotice.length ? onNotice.join(", ") : "none"
    }`,
  );
  push();

  // ── Tier 1 ──────────────────────────────────────────────
  const t1 = r.tier_1_anchor ?? {};
  push("TIER 1");
  if (t1.active) {
    push(`  ${na(t1.market)} — ${na(t1.selection)}`);
    push(`  Odds:${num(t1.odds)} Stake:${na(t1.stake)}`);
    push(`  EV:${signed(t1.ev)} (${na(t1.ev_rating)})`);
    push(`  Model prob:${na(t1.model_probability)}`);
  } else {
    push(`  INACTIVE — ${na(t1.skip_reason)}`);
    push(`  EV was: ${signed(t1.ev)}`);
  }
  push();

  // ── Tier 2 SGP ──────────────────────────────────────────
  const t2 = r.tier_2_parlay ?? {};
  const pe = t2.parlay_ev_inputs ?? {};
  push("TIER 2 SGP");
  if (t2.active) {
    const legs = t2.legs ?? [];
    if (legs.length) legs.forEach((leg, i) => push(fmtLeg(leg, i)));
    else push("  Legs: N/A");
    push(`  p_joint:${na(pe.p_joint)} stake_sgp:${na(pe.stake_sgp)}`);
    push(`  Parlay EV:${signed(t2.parlay_ev)}`);
    push(
      `  Stake:${na(t2.stake)} Return:${na(
        t2.returns?.potential_return_realistic,
      )}`,
    );
  } else {
    push(`  INACTIVE — ${na(t2.skip_reason)}`);
    push(`  Parlay EV was: ${signed(t2.parlay_ev)}`);
  }
  push();

  // ── Tier 3 ──────────────────────────────────────────────
  const t3 = r.tier_3_jackpot ?? {};
  const signals =
    Array.isArray(t3.class_c_signals) && t3.class_c_signals.length
      ? t3.class_c_signals.join(", ")
      : "none";
  push("TIER 3");
  if (t3.active) {
    push(`  CLASS C signals: ${signals}`);
    push(`  Odds:${num(t3.combined_odds)} Stake:${na(t3.stake)}`);
    push(`  EV:${signed(t3.jackpot_ev)}`);
  } else {
    push(`  INACTIVE — ${na(t3.skip_reason)}`);
    push(`  Signals found: ${signals}`);
  }
  push();

  push(`STAKED: ${na(r.total_staked)}`);
  push(`UNALLOCATED: ${na(r.unallocated_stake)}`);
  push();

  // ── Key risk / analyst note ─────────────────────────────
  push("KEY RISK");
  push(na(r.key_risk_flag));
  push();
  push("ANALYST NOTE");
  push(na(r.analyst_note));
  push();

  // ── Validation ──────────────────────────────────────────
  const mp = r.model_probabilities;
  push("VALIDATION");
  push(
    `Probs sum: ${num(mp?.raw_sum)}% ${
      mp?.was_normalized === undefined
        ? NA
        : mp.was_normalized
          ? "(normalized)"
          : "(not normalized)"
    }`,
  );
  push(
    `Ensemble overwrite: ${na(r.ensemble_check?.alignment)}`,
  );
  if (dwv) {
    if (dwv.validation_ran === false) push("Weights: NOT RUN");
    else if (dwv.sum_valid) push("Weights: PASSED");
    else push("Weights: MISMATCH");
    if (dwv.mismatch_flags && dwv.mismatch_flags.length) {
      push(dwv.mismatch_flags.join("; "));
    }
  } else {
    push("Weights: NOT RUN");
  }
  push();

  // ── Raw Claude JSON ─────────────────────────────────────
  push("RAW CLAUDE JSON");
  push(claudeRaw && claudeRaw.trim().length ? claudeRaw.trim() : NA);
  push(RULE);
  push("END EDGE RUN REPORT");

  return L.join("\n");
}
