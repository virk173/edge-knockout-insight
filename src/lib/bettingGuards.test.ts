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

  it("caps an inflated p_joint to min(leg prob) and flags it", () => {
    // min leg = 0.55, Claude claimed joint 0.62 (impossible).
    const out = calculateResults(sgp(0.62, [0.68, 0.62, 0.55]), { bankroll: 500 });
    expect(out.bet_3?.parlay_ev_inputs?.p_joint).toBe(0.55);
    // parlay_ev computed on the CAPPED value: 0.55*4.96-1 = 1.728
    expect(out.bet_3?.parlay_ev).toBeCloseTo(0.55 * 4.96 - 1, 3);
    expect(
      (out.data_quality_flags ?? []).some((f) => f.includes("p_joint")),
    ).toBe(true);
  });

  it("leaves a valid p_joint untouched", () => {
    const out = calculateResults(sgp(0.249, [0.68, 0.618, 0.58]), { bankroll: 500 });
    expect(out.bet_3?.parlay_ev_inputs?.p_joint).toBe(0.249);
    expect(out.data_quality_flags ?? []).toEqual(
      (out.data_quality_flags ?? []).filter((f) => !f.includes("p_joint")),
    );
  });

  // AUDIT FIX — the clamp silently no-oped when legs were missing/empty,
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
        f.includes("no leg probabilities"),
      ),
    ).toBe(true);
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
