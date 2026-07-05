import { describe, it, expect } from "vitest";
import { calculateResults, computeConfidence } from "./calculate";

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
