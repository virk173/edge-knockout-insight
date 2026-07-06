import { describe, it, expect } from "vitest";
import { calculateResults, computeConfidence, calculateKellyStake } from "./calculate";
import { calibrateProbability } from "./calibration";

// EDGE-FIX tier 5 — p_joint invariant clamp, ensemble mixed-scale guard,
// strip-regex tightening.

describe("p_joint invariant clamp — joint prob can never exceed the least likely leg", () => {
  const sgp = (p_joint: number, legProbs: number[]) => ({
    match: "A vs B",
    bet_3: {
      active: true,
      legs: legProbs.map((p, i) => ({
        leg_number: i + 1,
        market: "Goal Totals",
        selection: `Leg ${i + 1}`,
        odds: 1.9,
        model_probability: p,
      })),
      p_joint,
      parlay_ev_inputs: { p_joint, stake_sgp: 4.96 },
    },
  });

  it("recomputes an inflated p_joint from the leg product and flags it", () => {
    // Claude claimed joint 0.62; true product = 0.68 × 0.62 × 0.55 = 0.23188.
    const out = calculateResults(sgp(0.62, [0.68, 0.62, 0.55]), { bankroll: 500 });
    const product = 0.68 * 0.62 * 0.55;
    expect(out.bet_3?.parlay_ev_inputs?.p_joint).toBeCloseTo(product, 4);
    // parlay_ev computed on the RECOMPUTED value.
    expect(out.bet_3?.parlay_ev).toBeCloseTo(product * 4.96 - 1, 3);
    expect(
      (out.data_quality_flags ?? []).some((f) => f.includes("p_joint")),
    ).toBe(true);
  });

  it("accepts a p_joint consistent with the leg product without flagging", () => {
    // product = 0.68 × 0.618 × 0.58 = 0.24374 — Claude's 0.249 is within 0.01.
    const out = calculateResults(sgp(0.249, [0.68, 0.618, 0.58]), { bankroll: 500 });
    expect(out.bet_3?.parlay_ev_inputs?.p_joint).toBeCloseTo(0.68 * 0.618 * 0.58, 4);
    expect(out.data_quality_flags ?? []).toEqual(
      (out.data_quality_flags ?? []).filter((f) => !f.includes("p_joint")),
    );
  });

  // Live run 2026-07-04 (Canada vs Morocco): Claude emitted p_independent
  // 0.4455 for legs 0.45 × 0.55 × 0.60 = 0.1485 (3× too high). The old
  // min-leg cap only clipped p_joint to 0.45, publishing +185% parlay EV on
  // a truly negative-EV bet. The recompute must gate the bet inactive.
  it("regression: 3×-inflated p_joint → EV goes negative and the bet is gated", () => {
    const out = calculateResults(
      {
        match: "Canada vs Morocco",
        bet_3: {
          active: true,
          legs: [
            { leg_number: 1, market: "Moneyline (3-way)", selection: "Morocco Win", odds: 1.79, model_probability: 0.45 },
            { leg_number: 2, market: "Both Teams To Score", selection: "BTTS Yes", odds: 2.0, model_probability: 0.55 },
            { leg_number: 3, market: "Total Corners Over/Under", selection: "Over 8.5 Corners", odds: 1.77, model_probability: 0.6 },
          ],
          p_independent: 0.4455,
          correlation_factor: 1.02,
          p_joint: 0.4544,
          parlay_ev_inputs: { p_joint: 0.4544, stake_sgp: 6.34 },
        },
      },
      { bankroll: 500 },
    );
    const trueJoint = 0.45 * 0.55 * 0.6 * 1.02; // 0.15147
    expect(out.bet_3?.parlay_ev_inputs?.p_joint).toBeCloseTo(trueJoint, 4);
    expect(out.bet_3?.parlay_ev).toBeCloseTo(trueJoint * 6.34 - 1, 3); // ≈ -0.04
    expect(out.bet_3?.active).toBe(false);
    expect(
      (out.data_quality_flags ?? []).some((f) => f.includes("p_joint")),
    ).toBe(true);
  });

  // AUDIT FIX — the guard silently no-oped when legs were missing/empty,
  // letting an unverifiable p_joint straight into EV. Now the bet is withheld.
  it("p_joint with NO legs → bet_3 withheld (inactive, flagged), never priced as active", () => {
    const out = calculateResults(
      {
        match: "A vs B",
        bet_3: {
          active: true,
          legs: [],
          p_joint: 0.62,
          parlay_ev_inputs: { p_joint: 0.62, stake_sgp: 4.96 },
        },
      },
      { bankroll: 500 },
    );
    expect(out.bet_3?.active).toBe(false);
    expect(out.bet_3?.skip_reason).toContain("unverifiable");
    expect(
      (out.data_quality_flags ?? []).some((f) =>
        f.includes("missing or incomplete"),
      ),
    ).toBe(true);
  });
});

// Live E2E 2026-07-05 (Brazil vs Norway): a stale 10Bet cards quote (both
// sides of Cards 3.5 at 1.83, Pinnacle 2.66/1.46) produced a phantom +25.3%
// gap that survived the 15% haircut and became the top real-money bet. The
// >15% tier re-anchors EV to the Pinnacle price, which gates the bet.
describe("extreme Pinnacle divergence gate — full calculateResults path", () => {
  it("regression: Cards Under 3.5 @ 1.83 vs Pinnacle 1.46 → EV negative, bet inactive", () => {
    const out = calculateResults(
      {
        match: "Brazil vs Norway",
        bet_1: {
          active: true,
          market: "Total Cards Over/Under",
          selection: "Under 3.5 Cards",
          market_group: "E",
          ev_inputs: { model_probability: 0.6, decimal_odds: 1.83 },
          pinnacle_odds: 1.46,
        },
      },
      { bankroll: 500 },
    );
    expect(out.bet_1?.active).toBe(false);
    expect(out.bet_1?.ev).toBeLessThan(0);
    expect(out.bet_1?.ev_confidence).toBe("LOW");
    expect(out.bet_1?.pinnacle_check_note).toContain("re-anchored");
  });
});

describe("ensemble mixed-scale guard", () => {
  const base = (signals: [number, number, number]) => ({
    match: "A vs B",
    data_quality: "FULL",
    ensemble_check: {
      market: "Goals Total",
      signal_1_model: signals[0],
      signal_2_poisson: signals[1],
      signal_3_historical: signals[2],
    },
    confidence_scores: {
      confidence_inputs: { dimension_weighted_raw: 70, adjustments: [] },
    },
  });

  it("probability mixed with goals figures suppresses the ±5 impact and flags", () => {
    // 0.62 (a probability) vs 2.05/2.40 (goals) — |0.62-2.05| > 0.3 would be a
    // fake CONFLICT/-5 under the old behavior.
    const out = calculateResults(base([0.62, 2.05, 2.4]), { bankroll: 500 });
    expect(out.ensemble_check?.confidence_impact).toBe("0");
    expect(String(out.ensemble_check?.note)).toContain("MIXED SCALES");
    expect(
      (out.data_quality_flags ?? []).some((f) => f.includes("mixed scales")),
    ).toBe(true);
    // No ensemble delta injected into the confidence math.
    expect(out.confidence_scores?.post_adjustment).toBe(70);
  });

  it("same-scale signals keep the normal alignment math (real CONFLICT still -5)", () => {
    const out = calculateResults(base([1.7, 2.05, 2.4]), { bankroll: 500 });
    expect(out.ensemble_check?.alignment).toBe("CONFLICT");
    expect(out.ensemble_check?.confidence_impact).toBe("-5");
    expect(out.confidence_scores?.post_adjustment).toBe(65);
    expect(out.data_quality).toBe("PARTIAL");
  });
});

describe("confidence strip-regex — keep/strip table", () => {
  const run = (type: string) =>
    computeConfidence(
      { dimension_weighted_raw: 70, adjustments: [{ type, delta: -5 }] },
      { signal_1_model: 2.0, signal_2_poisson: 2.1, signal_3_historical: 2.2 },
    );

  const STRIPPED = [
    "3_signal_conflict",
    "3_signal_conflict_goals",
    "poisson_conflict_signal",
    "ensemble_alignment",
    "ensemble",
    "triple_aligned",
    "signal_alignment_check",
  ];
  const KEPT = [
    "sharp_money_confirms_Under",
    "sharp_money_signal", // contains "signal" but is NOT the ensemble dimension
    "style_conflict_cards", // contains "conflict" but is NOT the ensemble dimension
    "xG_proxy_used",
    "data_quality_PARTIAL",
  ];

  for (const t of STRIPPED) {
    it(`strips "${t}" (replaced by the single app-computed ensemble delta)`, () => {
      const conf = run(t)!;
      // TRIPLE ALIGNED signals → app injects +5; the Claude -5 must be gone.
      // post = 70 + 5 = 75 (no -5 surviving).
      expect(conf.post_adjustment).toBe(75);
      // Exactly ONE ensemble-dimension entry survives: the app-injected
      // {type:"ensemble_alignment", delta:+5}. Claude's -5 variant is gone.
      const ensembleEntries = conf.adjustments.filter(
        (a) => a.type === "ensemble_alignment" || a.type === t,
      );
      expect(ensembleEntries).toEqual([{ type: "ensemble_alignment", delta: 5 }]);
    });
  }

  for (const t of KEPT) {
    it(`keeps "${t}" (non-ensemble adjustment must survive)`, () => {
      const conf = run(t)!;
      // Kept -5 plus app-computed +5 → post = 70.
      expect(conf.adjustments.some((a) => a.type === t)).toBe(true);
      expect(conf.post_adjustment).toBe(70);
    });
  }
});

// Jackpot (bet_4) gets the same rule-28 treatment the SGP got: p_final and
// combined_odds are recomputed from the legs; a priced jackpot without
// verifiable legs is withheld.
describe("jackpot p_final guard — recompute from legs or withhold", () => {
  const legs = (probs: number[], odds: number[]) =>
    probs.map((p, i) => ({
      leg_number: i + 1,
      market: "Goal Totals",
      selection: `Leg ${i + 1}`,
      odds: odds[i],
      model_probability: p,
    }));

  it("recomputes an inflated p_final from the leg product and flags it", () => {
    const out = calculateResults(
      {
        match: "A vs B",
        bet_4: {
          active: true,
          legs: legs([0.6, 0.6, 0.6, 0.6], [1.9, 1.9, 1.9, 1.9]),
          combined_odds: 13.0,
          // True product = 0.6^4 = 0.1296; Claude claims 0.4 (3× too high).
          jackpot_ev_inputs: { p_final: 0.4, combined_odds: 13.0 },
        },
      },
      { bankroll: 500 },
    );
    expect(out.bet_4?.jackpot_ev_inputs?.p_final).toBeCloseTo(0.1296, 4);
    expect(out.bet_4?.jackpot_ev_inputs?.combined_odds).toBeCloseTo(1.9 ** 4, 2);
    // jackpot_ev on the RECOMPUTED values: 0.1296 × 13.0321 ≈ 0.689
    expect(out.bet_4?.jackpot_ev).toBeCloseTo(0.1296 * 1.9 ** 4 - 1, 2);
    expect(
      (out.data_quality_flags ?? []).some((f) => f.includes("p_final")),
    ).toBe(true);
  });

  it("withholds a priced jackpot whose legs lack probabilities", () => {
    const out = calculateResults(
      {
        match: "A vs B",
        bet_4: {
          active: true,
          legs: [{ leg_number: 1, stake_label: "..." }],
          jackpot_ev_inputs: { p_final: 0.2, combined_odds: 9.0 },
        },
      },
      { bankroll: 500 },
    );
    expect(out.bet_4?.active).toBe(false);
    expect(out.bet_4?.skip_reason).toContain("unverifiable");
  });

  it("leaves an unpriced inactive jackpot (the normal CLASS-C-failed case) untouched", () => {
    const out = calculateResults(
      {
        match: "A vs B",
        bet_4: {
          active: false,
          skip_reason: "CLASS C not achieved",
          legs: [],
          jackpot_ev_inputs: { p_final: 0, combined_odds: 0 },
        },
      },
      { bankroll: 500 },
    );
    expect(out.bet_4?.skip_reason).toBe("CLASS C not achieved");
    expect(
      (out.data_quality_flags ?? []).some((f) => f.includes("Jackpot")),
    ).toBe(false);
  });
});

// Dimension weights now AUTO-CORRECT to the Section 4 expected values on
// mismatch (live E2E: Claude transposed D5/D6; flag-only validation let the
// drifted weights flow downstream).
describe("dimension-weight auto-correction", () => {
  it("replaces drifted weights with the expected ones and keeps the originals in the validation object", () => {
    const out = calculateResults(
      {
        match: "A vs B",
        tactical_analysis: { call4_fixture_count: 5 },
        player_intelligence: { absences: [{ player: "X", classification: "MINOR" }] },
        // D5/D6 transposed vs the failed-H2H expectation (D6 must be 0).
        dimension_weights: { D1: 40, D2: 25, D3: 20, D4: 10, D5: 0, D6: 5, adjustment_reason: "H2H gate failed" },
      },
      { bankroll: 500, h2hMeetings: 1 },
    );
    expect(out.dimension_weights).toMatchObject({ D1: 40, D2: 25, D3: 20, D4: 10, D5: 5, D6: 0 });
    expect(out.dimension_weights?.adjustment_reason).toBe("H2H gate failed");
    expect(out.dimension_weights_validation?.weights).toMatchObject({ D5: 0, D6: 5 });
    expect(out.key_risk_flag).toContain("Auto-corrected");
  });

  it("leaves correct weights alone (no correction note)", () => {
    const out = calculateResults(
      {
        match: "A vs B",
        tactical_analysis: { call4_fixture_count: 5 },
        player_intelligence: { absences: [{ player: "X", classification: "MINOR" }] },
        dimension_weights: { D1: 40, D2: 25, D3: 20, D4: 10, D5: 5, D6: 0 },
      },
      { bankroll: 500, h2hMeetings: 1 },
    );
    expect(out.key_risk_flag ?? "").not.toContain("Auto-corrected");
    expect(out.dimension_weights).toMatchObject({ D1: 40, D6: 0 });
  });
});

// Manual executable-price confirmation (the odds feed is a proxy book).
import { applyConfirmedPrice } from "./calculate";

describe("applyConfirmedPrice", () => {
  const base = () =>
    calculateResults(
      {
        match: "A vs B",
        bet_1: {
          active: true,
          market: "Goal Totals",
          selection: "Over 2.5 Goals",
          ev_inputs: { model_probability: 0.65, decimal_odds: 1.7 },
        },
      },
      { bankroll: 500, lambda: 1 },
    );

  it("re-prices at the confirmed odds and keeps the bet when EV still clears", () => {
    const out = applyConfirmedPrice(base(), "bet_1", 1.72);
    // p 0.65 × 1.72 − 1 = 0.118 ≥ 0.05 → still on, Kelly re-sized.
    expect(out.bet_1?.active).toBe(true);
    expect(out.bet_1?.price_confirmed).toBe(true);
    expect(out.bet_1?.odds).toBe(1.72);
    expect(out.bet_1?.ev).toBeCloseTo(0.65 * 1.72 - 1, 3);
  });

  it("gates the bet to $0 when the confirmed price kills the edge", () => {
    const out = applyConfirmedPrice(base(), "bet_1", 1.45);
    // p 0.65 × 1.45 − 1 = −0.0575 → inactive, do-not-place reason.
    expect(out.bet_1?.active).toBe(false);
    expect(out.bet_1?.stake).toBe("$0");
    expect(out.bet_1?.skip_reason).toContain("Do not place");
  });

  it("never mutates the input result", () => {
    const before = base();
    const snapshot = JSON.stringify(before);
    applyConfirmedPrice(before, "bet_1", 1.45);
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});

// Runtime integrity self-audit — asserted on every enriched result.
import { verifyResultIntegrity } from "./calculate";

describe("verifyResultIntegrity", () => {
  it("passes a clean enriched result end-to-end (integrity attached by calculateResults)", () => {
    const out = calculateResults(
      {
        match: "A vs B",
        data_quality: "PARTIAL",
        line_movement_signals: [],
        bet_1: {
          active: true,
          market: "Goal Totals",
          selection: "Over 2.5 Goals",
          ev_inputs: { model_probability: 0.65, decimal_odds: 1.7 },
        },
      },
      { bankroll: 500, lambda: 1, strictMode: false },
    );
    expect(out.integrity?.passed).toBe(true);
    expect(out.integrity?.violations).toEqual([]);
  });

  it("catches an active bet below its EV gate, bad stakes, and fabricated movement signals", () => {
    const { passed, violations } = verifyResultIntegrity({
      match: "A vs B",
      data_quality: "FULL",
      line_movement_signals: [{ market: "1X2", signal: "sharp" }],
      ensemble_check: { alignment: "CONFLICT" },
      bankroll_at_analysis: 500,
      total_staked: "$99.00",
      bet_1: {
        active: true,
        ev: 0.01, // below the 0.05 gate
        odds: 1.7,
        model_probability: 0.65,
        stake: "$12",
      },
    } as never);
    expect(passed).toBe(false);
    const text = violations.join(" | ");
    expect(text).toContain("below its 0.05 gate");
    expect(text).toContain("line_movement_signals");
    expect(text).toContain("CONFLICT");
    expect(text).toContain("total_staked");
  });

  it("catches an active jackpot with the wrong leg count and an exposure-cap breach", () => {
    const { passed, violations } = verifyResultIntegrity({
      match: "A vs B",
      bankroll_at_analysis: 500,
      total_staked: "$40.00",
      bet_4: {
        active: true,
        jackpot_ev: 0.2,
        stake: "$40",
        legs: [{ leg_number: 1, odds: 2, model_probability: 0.5 }],
      },
    } as never);
    expect(passed).toBe(false);
    const text = violations.join(" | ");
    expect(text).toContain("jackpot requires 4-5");
    expect(text).toContain("exposure cap");
  });
});

// ─────────────────────────────────────────────────────────────
// Audit 2026-07-05 — adversarial-workflow findings
// ─────────────────────────────────────────────────────────────
describe("probability sanitation (audit: percent-form p bypassed every gate)", () => {
  it("converts a percent-form model_probability and flags it", () => {
    const out = calculateResults(
      {
        match: "A vs B",
        bet_1: {
          active: true,
          market: "Goal Totals",
          selection: "Over 2.5 Goals",
          ev_inputs: { model_probability: 65, decimal_odds: 1.7 },
        },
      },
      { bankroll: 500, lambda: 1 },
    );
    // 65 → 0.65 → EV 0.105, a sane active bet instead of EV +109.5.
    expect(out.bet_1?.ev).toBeCloseTo(0.65 * 1.7 - 1, 3);
    expect(out.bet_1?.model_probability).toBeCloseTo(0.65, 4);
    expect(
      (out.data_quality_flags ?? []).some((f) => f.includes("percent-form")),
    ).toBe(true);
  });

  it("withholds a bet whose probability is garbage even after conversion", () => {
    const out = calculateResults(
      {
        match: "A vs B",
        bet_1: {
          active: true,
          ev_inputs: { model_probability: 850, decimal_odds: 1.7 },
        },
      },
      { bankroll: 500 },
    );
    expect(out.bet_1?.active).toBe(false);
    expect(out.bet_1?.skip_reason).toContain("withheld");
  });
});

describe("Kelly sizing hardening (audit: Claude-controlled kelly odds → Infinity Kelly)", () => {
  it("calculateKellyStake refuses odds <= 1", () => {
    const k = calculateKellyStake({
      ev: 0.1,
      decimal_odds: 1.0,
      bankroll: 500,
      fraction: 0.25,
      max_bet_pct: 0.025,
      min_actionable: 2,
    });
    expect(k.recommended_stake).toBe(0);
    expect(k.reasoning).toContain("Invalid decimal odds");
  });

  it("app-verified bet.odds outranks Claude's kelly_inputs.decimal_odds", () => {
    const out = calculateResults(
      {
        match: "A vs B",
        bet_1: {
          active: true,
          ev_inputs: { model_probability: 0.6, decimal_odds: 2.0 },
          kelly_inputs: { decimal_odds: 1.0 }, // poisoned — would be Infinity Kelly
        },
      },
      { bankroll: 500, lambda: 1 },
    );
    expect(out.bet_1?.kelly_inputs?.decimal_odds).toBe(2.0);
    expect(Number.isFinite(out.bet_1?.kelly_result?.raw_stake ?? NaN)).toBe(true);
  });
});

describe("SGP price cap (audit: stake_sgp never checked against leg-odds product)", () => {
  it("caps an inflated stake_sgp at the independent product of leg odds", () => {
    const out = calculateResults(
      {
        match: "A vs B",
        bet_3: {
          active: true,
          legs: [
            { leg_number: 1, market: "Goal Totals", selection: "L1", odds: 1.5, model_probability: 0.6 },
            { leg_number: 2, market: "Goal Totals", selection: "L2", odds: 1.6, model_probability: 0.6 },
            { leg_number: 3, market: "Goal Totals", selection: "L3", odds: 1.7, model_probability: 0.6 },
          ],
          p_joint: 0.216,
          parlay_ev_inputs: { p_joint: 0.216, stake_sgp: 9.0 },
        },
      },
      { bankroll: 500 },
    );
    const product = 1.5 * 1.6 * 1.7; // 4.08
    expect(out.bet_3?.parlay_ev_inputs?.stake_sgp).toBeCloseTo(product, 2);
    expect(out.bet_3?.parlay_ev).toBeCloseTo(0.216 * product - 1, 2);
    expect(
      (out.data_quality_flags ?? []).some((f) => f.includes("independent product")),
    ).toBe(true);
  });
});

describe("APP-POISSON pin + pipeline lineup truth (audit: echoed signals / model lineup claims)", () => {
  it("pins ensemble signal_1 to the app-computed Poisson total and flags divergence", () => {
    const out = calculateResults(
      {
        match: "A vs B",
        data_quality: "FULL",
        ensemble_check: {
          market: "Goals Total",
          signal_1_model: 2.2, // echoed to match the others → fake TRIPLE ALIGNED
          signal_2_poisson: 2.2,
          signal_3_historical: 2.2,
        },
        confidence_scores: {
          confidence_inputs: { dimension_weighted_raw: 70, adjustments: [] },
        },
      },
      { bankroll: 500, appPoissonTotal: 3.1 },
    );
    expect(out.ensemble_check?.signal_1_model).toBe(3.1);
    expect(out.ensemble_check?.alignment).not.toBe("TRIPLE ALIGNED");
    expect(
      (out.data_quality_flags ?? []).some((f) => f.includes("APP-POISSON")),
    ).toBe(true);
  });

  it("opts.lineupConfirmed overrides the model's lineup_confirmed claim", () => {
    const out = calculateResults(
      { match: "A vs B", lineup_confirmed: true },
      { bankroll: 500, lineupConfirmed: false },
    );
    expect(out.lineup_confirmed).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// Codex adversarial review 2026-07-05 — cross-model findings
// ─────────────────────────────────────────────────────────────
describe("Codex finding 1 — straight bets require app-recomputable ev_inputs", () => {
  it("withholds an active bet that ships bet.ev without ev_inputs", () => {
    const out = calculateResults(
      {
        match: "A vs B",
        bet_1: {
          active: true,
          market: "Goal Totals",
          selection: "Over 2.5 Goals",
          odds: 1.9,
          model_probability: 0.6,
          ev: 0.14, // Claude-claimed EV, no raw inputs to verify it
        },
      },
      { bankroll: 500 },
    );
    expect(out.bet_1?.active).toBe(false);
    expect(out.bet_1?.ev).toBeUndefined();
    expect(out.bet_1?.stake).toBe("$0");
    expect(out.bet_1?.skip_reason).toContain("ev_inputs");
    expect(
      (out.data_quality_flags ?? []).some((f) => f.includes("rule 28")),
    ).toBe(true);
  });

  it("integrity flags an active bet lacking ev_inputs", () => {
    const { passed, violations } = verifyResultIntegrity({
      match: "A vs B",
      bet_1: { active: true, ev: 0.1, odds: 1.9, model_probability: 0.6, stake: "$10" },
    } as never);
    expect(passed).toBe(false);
    expect(violations.join(" | ")).toContain("ev_inputs");
  });
});

describe("Codex finding 2 — undefined EV is a hard gate failure before sizing", () => {
  it("a model-active SGP with uncomputable parlay_ev never receives a stake", () => {
    const out = calculateResults(
      {
        match: "A vs B",
        bet_3: {
          active: true,
          legs: [
            { leg_number: 1, market: "Goal Totals", selection: "L1", odds: 1.9, model_probability: 0.6 },
            { leg_number: 2, market: "Goal Totals", selection: "L2", odds: 1.9, model_probability: 0.6 },
            { leg_number: 3, market: "Goal Totals", selection: "L3", odds: 1.9, model_probability: 0.6 },
          ],
          // No parlay_ev_inputs at all → parlay_ev never computed.
        },
      },
      { bankroll: 500, strictMode: false },
    );
    expect(out.bet_3?.active).toBe(false);
    expect(out.bet_3?.stake).toBe("$0");
  });

  it("a model-active jackpot with no computable jackpot_ev never receives a stake (strict mode off)", () => {
    const out = calculateResults(
      {
        match: "A vs B",
        classification: "JACKPOT",
        bet_4: {
          active: true,
          legs: [1, 2, 3, 4].map((n) => ({
            leg_number: n,
            market: "Goal Totals",
            selection: `L${n}`,
            odds: 1.8,
            model_probability: 0.6,
          })),
          // No jackpot_ev_inputs → the EV chain never produces jackpot_ev...
          // except the leg-recompute guard prices it; remove legs' odds to
          // block that too? No — keep this as the pure missing-inputs case:
        },
      },
      { bankroll: 500, strictMode: false },
    );
    // Either the guard withheld it or the gate did — it must never be active
    // with a stake and no finite jackpot_ev.
    const b4 = out.bet_4;
    if (b4?.active) {
      expect(Number.isFinite(b4.jackpot_ev ?? NaN)).toBe(true);
    } else {
      expect(b4?.stake ?? "$0").toBe("$0");
    }
  });
});

describe("Codex finding 3 — lambda and calibrated probability are clamped", () => {
  it("a corrupted lambda > 1 cannot expand the model probability past validity", () => {
    // p 0.9 @ odds 1.4 (market 0.714), λ 5 uncapped → 0.714 + 5×0.186 = 1.64.
    const out = calculateResults(
      {
        match: "A vs B",
        bet_1: {
          active: true,
          ev_inputs: { model_probability: 0.9, decimal_odds: 1.4 },
        },
      },
      { bankroll: 500, lambda: 5 },
    );
    const p = out.bet_1?.model_probability ?? 0;
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(1);
    // λ clamps to 1 → calibrated = raw 0.9 → EV = 0.9×1.4−1 = 0.26.
    expect(out.bet_1?.ev).toBeCloseTo(0.26, 3);
  });

  it("calibrateProbability never returns a value outside (0,1)", () => {
    expect(calibrateProbability(0.9, 1.4, 5)).toBeLessThan(1);
    expect(calibrateProbability(0.1, 10, -3)).toBeGreaterThan(0);
    expect(calibrateProbability(0.5, 2, Number.NaN)).toBeGreaterThan(0);
  });
});

// Codex round-2 findings — bypasses in the round-1 guards themselves.
describe("Codex round 2 — guard bypasses closed", () => {
  it("model-emitted parlay_ev without parlay_ev_inputs is never trusted", () => {
    const out = calculateResults(
      {
        match: "A vs B",
        bet_3: {
          active: true,
          parlay_ev: 0.2, // fabricated — no inputs block at all
          legs: [
            { leg_number: 1, market: "Goal Totals", selection: "L1", odds: 1.9, model_probability: 0.6 },
            { leg_number: 2, market: "Goal Totals", selection: "L2", odds: 1.9, model_probability: 0.6 },
            { leg_number: 3, market: "Goal Totals", selection: "L3", odds: 1.9, model_probability: 0.6 },
          ],
        },
      },
      { bankroll: 500, strictMode: false },
    );
    expect(out.bet_3?.active).toBe(false);
    expect(out.bet_3?.stake).toBe("$0");
  });

  it("model-emitted jackpot_ev without jackpot_ev_inputs is never trusted", () => {
    const out = calculateResults(
      {
        match: "A vs B",
        classification: "JACKPOT",
        bet_4: {
          active: true,
          jackpot_ev: 0.25, // fabricated
          legs: [1, 2, 3, 4].map((n) => ({
            leg_number: n,
            market: "Goal Totals",
            selection: `L${n}`,
            odds: 1.8,
            model_probability: 0.6,
          })),
        },
      },
      { bankroll: 500, strictMode: false },
    );
    expect(out.bet_4?.active).toBe(false);
    expect(out.bet_4?.stake).toBe("$0");
  });

  it("applyConfirmedPrice refuses to resurrect a bet withheld for missing ev_inputs", () => {
    const withheld = calculateResults(
      {
        match: "A vs B",
        bet_1: {
          active: true,
          model_probability: 0.9, // leftover Claude field, no ev_inputs
          odds: 1.9,
          ev: 0.71,
        },
      },
      { bankroll: 500 },
    );
    expect(withheld.bet_1?.active).toBe(false);
    const after = applyConfirmedPrice(withheld, "bet_1", 2.0);
    expect(after.bet_1?.active).toBe(false);
    expect(after.bet_1?.price_confirmed).toBeUndefined();
    expect(after.bet_1?.stake).toBe("$0");
  });

  it("applyConfirmedPrice re-runs the integrity self-audit on the re-priced result", () => {
    const base = calculateResults(
      {
        match: "A vs B",
        bet_1: {
          active: true,
          market: "Goal Totals",
          selection: "Over 2.5 Goals",
          ev_inputs: { model_probability: 0.65, decimal_odds: 1.7 },
        },
      },
      { bankroll: 500, lambda: 1, strictMode: false },
    );
    const after = applyConfirmedPrice(base, "bet_1", 1.72);
    expect(after.integrity).toBeDefined();
    expect(after.integrity?.passed).toBe(true);
  });
});

// Codex round-3 finding — re-pricing must derive probability from raw inputs.
describe("Codex round 3 — applyConfirmedPrice recomputes probability from ev_inputs", () => {
  it("an inflated stored model_probability cannot drive the re-priced stake", () => {
    const base = calculateResults(
      {
        match: "A vs B",
        bet_1: {
          active: true,
          market: "Goal Totals",
          selection: "Over 2.5 Goals",
          ev_inputs: { model_probability: 0.55, decimal_odds: 2.0 },
        },
      },
      { bankroll: 500, lambda: 1, strictMode: false },
    );
    // Simulate a stale/corrupted enriched object: inflated display probability.
    base.bet_1!.model_probability = 5;
    const after = applyConfirmedPrice(base, "bet_1", 2.0);
    // Probability recomputed from ev_inputs (λ=1 → 0.55), NOT the stored 5.
    expect(after.bet_1?.model_probability).toBeCloseTo(0.55, 3);
    expect(after.bet_1?.ev).toBeCloseTo(0.55 * 2.0 - 1, 3);
    expect(after.integrity?.passed).toBe(true);
  });
});

// Codex round-4 finding — invalid probability branch must be a hard stop.
describe("Codex round 4 — invalid ev_inputs probability cannot fall back to model-emitted EV", () => {
  it("garbage probability + model-supplied top-level ev/odds → withheld, $0, never reactivated", () => {
    const out = calculateResults(
      {
        match: "A vs B",
        bet_1: {
          active: true,
          market: "Goal Totals",
          selection: "Over 2.5 Goals",
          ev_inputs: { model_probability: 850, decimal_odds: 1.7 },
          odds: 1.7,
          ev: 0.2, // model-supplied — must never reach sizing
        },
      },
      { bankroll: 500, strictMode: false },
    );
    expect(out.bet_1?.active).toBe(false);
    expect(out.bet_1?.stake).toBe("$0");
    expect(out.bet_1?.ev).toBeUndefined();
    expect(out.bet_1?.kelly_result).toBeUndefined();
  });

  it("integrity rejects an active bet whose ev_inputs probability is not a valid fraction", () => {
    const { passed, violations } = verifyResultIntegrity({
      match: "A vs B",
      bet_1: {
        active: true,
        ev: 0.1,
        odds: 1.9,
        model_probability: 0.6,
        stake: "$10",
        ev_inputs: { model_probability: 850, decimal_odds: 1.9 },
      },
    } as never);
    expect(passed).toBe(false);
    expect(violations.join(" | ")).toContain("ev_inputs");
  });
});

// Codex round-5 finding — version skew: a pre-fix cached ACTIVE bet with
// invalid ev_inputs must be sanitized at the price-confirmation boundary,
// never returned unchanged with its stale stake.
describe("Codex round 5 — applyConfirmedPrice sanitizes stale invalid active bets", () => {
  it("an active cached bet with invalid ev_inputs is withheld on confirm, not preserved", () => {
    const staleCached = {
      match: "A vs B",
      bet_1: {
        active: true,
        ev: 0.2,
        odds: 1.7,
        stake: "$12",
        model_probability: 0.9,
        ev_inputs: { model_probability: 850, decimal_odds: 1.7 },
        kelly_result: { recommended_stake: 12 },
      },
    } as never;
    const after = applyConfirmedPrice(staleCached, "bet_1", 1.8);
    expect(after.bet_1?.active).toBe(false);
    expect(after.bet_1?.stake).toBe("$0");
    expect(after.bet_1?.ev).toBeUndefined();
    expect(after.bet_1?.skip_reason).toContain("withheld");
    expect(after.integrity).toBeDefined();
  });

  it("a typo in the confirmed odds leaves the bet untouched (no mutation on bad user input)", () => {
    const base = calculateResults(
      {
        match: "A vs B",
        bet_1: {
          active: true,
          ev_inputs: { model_probability: 0.65, decimal_odds: 1.7 },
        },
      },
      { bankroll: 500, lambda: 1, strictMode: false },
    );
    const after = applyConfirmedPrice(base, "bet_1", 0.9);
    expect(after.bet_1?.active).toBe(true);
    expect(after.bet_1?.price_confirmed).toBeUndefined();
  });
});

// Codex round-6 finding — cached parlays must fail integrity without the full
// raw input set, and the stored EV must equal the recompute.
describe("Codex round 6 — hydration integrity binds parlay EV to its inputs", () => {
  it("cached active bet_3 missing stake_sgp fails integrity", () => {
    const { passed, violations } = verifyResultIntegrity({
      match: "A vs B",
      bet_3: {
        active: true,
        stake: "$5",
        parlay_ev: 0.2, // model-emitted, no price to recompute from
        parlay_ev_inputs: { p_joint: 0.25 },
        legs: [
          { leg_number: 1, odds: 1.9, model_probability: 0.6 },
          { leg_number: 2, odds: 1.9, model_probability: 0.6 },
          { leg_number: 3, odds: 1.9, model_probability: 0.7 },
        ],
      },
    } as never);
    expect(passed).toBe(false);
    expect(violations.join(" | ")).toContain("full parlay_ev_inputs");
  });

  it("cached active bet_3 whose parlay_ev disagrees with its inputs fails integrity", () => {
    const { passed, violations } = verifyResultIntegrity({
      match: "A vs B",
      bet_3: {
        active: true,
        stake: "$5",
        parlay_ev: 0.5, // fabricated — inputs say 0.25 × 4.96 − 1 = 0.24
        parlay_ev_inputs: { p_joint: 0.25, stake_sgp: 4.96 },
        legs: [
          { leg_number: 1, odds: 1.9, model_probability: 0.6 },
          { leg_number: 2, odds: 1.9, model_probability: 0.6 },
          { leg_number: 3, odds: 1.9, model_probability: 0.7 },
        ],
      },
    } as never);
    expect(passed).toBe(false);
    expect(violations.join(" | ")).toContain("does not equal");
  });

  it("cached active bet_4 missing combined_odds fails integrity", () => {
    const { passed, violations } = verifyResultIntegrity({
      match: "A vs B",
      bet_4: {
        active: true,
        stake: "$3",
        jackpot_ev: 0.3,
        jackpot_ev_inputs: { p_final: 0.13 },
        legs: [1, 2, 3, 4].map((n) => ({ leg_number: n, odds: 1.8, model_probability: 0.6 })),
      },
    } as never);
    expect(passed).toBe(false);
    expect(violations.join(" | ")).toContain("full jackpot_ev_inputs");
  });
});

// App-enforced consensus stale-quote guard (previously prompt-only). The
// proven failure mode: 10Bet quoting Cards Under 3.5 at 1.83 while the
// multi-book median sat at 1.50 — no Pinnacle price to re-anchor against.
import { findConsensusMedian } from "./calculate";

describe("consensus stale-quote guard — app-enforced >10% rule", () => {
  const consensus = {
    books_counted: 8,
    markets: {
      "Cards Over/Under": [
        { value: "Under 3.5", median_odd: 1.5, books: 5 },
        { value: "Over 3.5", median_odd: 2.4, books: 5 },
      ],
      "1X2 (Match Winner)": [
        { value: "Home", median_odd: 1.79, books: 13 },
        { value: "Away", median_odd: 4.55, books: 13 },
        { value: "Draw", median_odd: 3.67, books: 13 },
      ],
      "Over/Under 2.5 Goals": [{ value: "Over 2.5", median_odd: 1.74, books: 12 }],
    },
  };

  it("findConsensusMedian resolves markets and team-name selections conservatively", () => {
    expect(
      findConsensusMedian(consensus, "Total Cards Over/Under", "Under 3.5 Cards", "Brazil", "Norway"),
    ).toEqual({ median: 1.5, books: 5 });
    expect(
      findConsensusMedian(consensus, "Moneyline (3-way)", "Brazil Win", "Brazil", "Norway"),
    ).toEqual({ median: 1.79, books: 13 });
    // Unknown market / thin consensus → undefined, never a guess.
    expect(
      findConsensusMedian(consensus, "Asian Handicap", "Home -1", "Brazil", "Norway"),
    ).toBeUndefined();
    expect(
      findConsensusMedian(
        { markets: { "Cards Over/Under": [{ value: "Under 3.5", median_odd: 1.5, books: 2 }] } },
        "Cards", "Under 3.5", "A", "B",
      ),
    ).toBeUndefined();
  });

  it("re-anchors a no-Pinnacle straight bet priced >10% above the consensus median", () => {
    const out = calculateResults(
      {
        match: "Brazil vs Norway",
        bet_1: {
          active: true,
          market: "Total Cards Over/Under",
          selection: "Under 3.5 Cards",
          ev_inputs: { model_probability: 0.6, decimal_odds: 1.83 },
          pinnacle_odds: null, // no sharp anchor — the exact live gap
        },
      },
      { bankroll: 500, lambda: 1, consensusOdds: consensus },
    );
    // Re-anchored: 0.6 × 1.50 − 1 = −0.10 → gated inactive.
    expect(out.bet_1?.active).toBe(false);
    expect(out.bet_1?.ev).toBeLessThan(0);
    expect(out.bet_1?.ev_confidence).toBe("LOW");
    expect(
      (out.data_quality_flags ?? []).some((f) => f.includes("consensus median")),
    ).toBe(true);
  });

  it("caps an SGP leg priced >10% above the consensus median before products are computed", () => {
    const out = calculateResults(
      {
        match: "Brazil vs Norway",
        bet_3: {
          active: true,
          legs: [
            { leg_number: 1, market: "Moneyline (3-way)", selection: "Brazil Win", odds: 1.79, model_probability: 0.55 },
            { leg_number: 2, market: "Goal Totals", selection: "Over 2.5 Goals", odds: 1.74, model_probability: 0.6 },
            { leg_number: 3, market: "Total Cards Over/Under", selection: "Under 3.5 Cards", odds: 1.83, model_probability: 0.6 },
          ],
          p_joint: 0.2,
          parlay_ev_inputs: { p_joint: 0.2, stake_sgp: 5.0 },
        },
      },
      { bankroll: 500, consensusOdds: consensus },
    );
    const leg3 = out.bet_3?.legs?.[2];
    expect(leg3?.odds).toBe(1.5); // capped to the median
    // stake_sgp re-capped by the now-honest product: 1.79 × 1.74 × 1.50 = 4.67.
    expect(out.bet_3?.parlay_ev_inputs?.stake_sgp).toBeLessThanOrEqual(1.79 * 1.74 * 1.5 * 1.02);
    expect(
      (out.data_quality_flags ?? []).some((f) => f.includes("capped to the median")),
    ).toBe(true);
  });

  it("leaves fairly-priced bets untouched (no false positives)", () => {
    const out = calculateResults(
      {
        match: "Brazil vs Norway",
        bet_1: {
          active: true,
          market: "Moneyline (3-way)",
          selection: "Brazil Win",
          ev_inputs: { model_probability: 0.62, decimal_odds: 1.8 }, // median 1.79 — within 10%
          pinnacle_odds: null,
        },
      },
      { bankroll: 500, lambda: 1, consensusOdds: consensus },
    );
    expect(out.bet_1?.ev).toBeCloseTo(0.62 * 1.8 - 1, 3);
    expect(
      (out.data_quality_flags ?? []).some((f) => f.includes("consensus median")),
    ).toBe(false);
  });
});

// Jackpot-logic rework 2026-07-05: bet_4 legs get the same app-computed
// per-leg EV as bet_3 legs, and qualifyJackpot refuses real money when any
// leg is missing/negative EV — mirroring the bet_3 leg gate.
describe("jackpot per-leg EV and the every-leg-positive real-money gate", () => {
  const jackpot = (probs: number[], oddsArr: number[]) => ({
    match: "A vs B",
    classification: "JACKPOT",
    data_quality: "FULL",
    lineup_dependency: { level: "LOW" },
    bet_4: {
      active: true,
      legs: probs.map((p, i) => ({
        leg_number: i + 1,
        market: "Total Goals Over/Under",
        selection: `Leg ${i + 1}`,
        odds: oddsArr[i],
        model_probability: p,
      })),
      jackpot_ev_inputs: {
        p_final: probs.reduce((a, b) => a * b, 1),
        combined_odds: oddsArr.reduce((a, b) => a * b, 1),
      },
    },
  });

  it("computes per-leg EV for every jackpot leg (no Pinnacle → raw EV, MEDIUM confidence)", () => {
    const out = calculateResults(jackpot([0.6, 0.6, 0.6, 0.6], [1.9, 1.9, 1.9, 1.9]), {
      bankroll: 500,
    });
    for (const leg of out.bet_4?.legs ?? []) {
      expect(leg.ev).toBeCloseTo(0.6 * 1.9 - 1, 3);
      expect(leg.ev_confidence).toBe("MEDIUM");
    }
  });

  it("a qualifying CLASS C jackpot with all-positive legs rides real money", () => {
    const out = calculateResults(jackpot([0.6, 0.6, 0.6, 0.6], [1.9, 1.9, 1.9, 1.9]), {
      bankroll: 500,
    });
    expect(out.bet_4?.active).toBe(true);
    expect(out.bet_4?.paper_bet).not.toBe(true);
    expect(out.bet_4?.paper_reason).toBeUndefined();
  });

  it("one negative-EV leg forces the jackpot to paper even when total EV clears the gate", () => {
    // Leg 4: 0.6 × 1.5 − 1 = −0.10; total EV 0.1296 × 10.29 − 1 ≈ +0.33.
    const out = calculateResults(jackpot([0.6, 0.6, 0.6, 0.6], [1.9, 1.9, 1.9, 1.5]), {
      bankroll: 500,
    });
    expect(out.bet_4?.active).toBe(true);
    expect(out.bet_4?.jackpot_ev).toBeGreaterThan(0.05);
    expect(out.bet_4?.paper_bet).toBe(true);
    expect(out.bet_4?.paper_reason).toContain("jackpot leg");
  });

  it("a COMPETITIVE (non-CLASS-C) classification still paper-trades the jackpot", () => {
    const base = jackpot([0.6, 0.6, 0.6, 0.6], [1.9, 1.9, 1.9, 1.9]);
    const out = calculateResults({ ...base, classification: "COMPETITIVE" }, { bankroll: 500 });
    expect(out.bet_4?.paper_bet).toBe(true);
    expect(out.bet_4?.paper_reason).toContain("CLASS C");
  });
});
