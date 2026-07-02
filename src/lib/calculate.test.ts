import { describe, it, expect } from "vitest";
import {
  calculateEV,
  calculateSGPEV,
  calculateKellyStake,
  validateModelProbabilities,
  calculateEnsembleAlignment,
  detectDeadRubber,
  adjustEVForPinnacleGap,
  validateDimensionWeights,
  calculateResults,
  applyDeadRubberDiscount,
  computeConfidence,
} from "@/lib/calculate";
import { resolveMarketType, generateStakeLabel } from "@/lib/bettingGlossary";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// GROUP 1 — calculateEV
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe("calculateEV", () => {
  it("returns correct positive EV", () => {
    // model prob 0.56, odds 2.00
    // EV = 0.56 * 2.00 - 1 = 0.12
    expect(
      calculateEV({
        model_probability: 0.56,
        decimal_odds: 2.0,
      }),
    ).toBeCloseTo(0.12, 4);
  });

  it("returns correct negative EV", () => {
    // model prob 0.565, odds 1.38
    // EV = 0.565 * 1.38 - 1 = -0.220
    // France vs Sweden Tier 1 from tonight
    expect(
      calculateEV({
        model_probability: 0.565,
        decimal_odds: 1.38,
      }),
    ).toBeCloseTo(-0.22, 3);
  });

  it("returns zero EV at breakeven", () => {
    // prob 0.5, odds 2.0 = exactly 0
    expect(
      calculateEV({
        model_probability: 0.5,
        decimal_odds: 2.0,
      }),
    ).toBeCloseTo(0, 10);
  });

  it("handles zero probability", () => {
    expect(
      calculateEV({
        model_probability: 0,
        decimal_odds: 2.0,
      }),
    ).toBe(-1);
  });

  it("handles zero odds gracefully", () => {
    // Should not throw, return -1 or handle as invalid
    const result = calculateEV({
      model_probability: 0.5,
      decimal_odds: 0,
    });
    expect(result).toBeLessThanOrEqual(-1);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// GROUP 2 — calculateSGPEV / parlay EV
// Corrected formula: parlay_ev = p_joint × stake_sgp − 1.
// The hold_rate is diagnostic ONLY and never enters the EV math (it is already
// embedded in the offered stake_sgp price). The old tests fed the double-vig
// p_final / effective_sgp_price pair; these now feed p_joint + stake_sgp.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe("calculateSGPEV", () => {
  it("Norway vs Ivory Coast — same legs, corrected (no double-vig)", () => {
    // Tonight this parlay showed -0.396 under the buggy double-vig formula
    // (p_final 0.133 × effective_sgp 4.54). Those were the post-hold values with
    // hold_rate 0.175. Recovering the true inputs:
    //   p_joint   = 0.133 / (1 - 0.175)          = 0.1612
    //   stake_sgp = 4.54  / ((1 - 0.175) × 1.05) = 5.241
    // Correct EV = 0.1612 × 5.241 − 1 = -0.155 (still negative, but +0.24
    // better than the mechanical -0.396 the bug produced).
    expect(
      calculateSGPEV({
        p_joint: 0.1612,
        stake_sgp: 5.241,
      }),
    ).toBeCloseTo(-0.155, 3);
  });

  it("France vs Sweden — same legs, corrected (no double-vig)", () => {
    // Buggy: p_final 0.169 × effective 3.57 = -0.397 (hold_rate 0.175).
    //   p_joint   = 0.169 / 0.825            = 0.2048
    //   stake_sgp = 3.57  / (0.825 × 1.05)   = 4.121
    // Correct EV = 0.2048 × 4.121 − 1 = -0.156.
    expect(
      calculateSGPEV({
        p_joint: 0.2048,
        stake_sgp: 4.121,
      }),
    ).toBeCloseTo(-0.156, 3);
  });

  it("returns positive EV for a genuinely good parlay", () => {
    // p_joint 0.30, stake_sgp 4.00 → EV = 0.30 × 4.00 − 1 = 0.20
    expect(
      calculateSGPEV({
        p_joint: 0.3,
        stake_sgp: 4.0,
      }),
    ).toBeCloseTo(0.2, 4);
  });

  it("ignores hold_rate — it is diagnostic only, not part of the EV math", () => {
    // Passing hold_rate must not change the result vs omitting it.
    const withHold = calculateSGPEV({
      p_joint: 0.253,
      stake_sgp: 4.96,
      hold_rate: 0.175,
    } as { p_joint: number; stake_sgp: number; hold_rate: number });
    const withoutHold = calculateSGPEV({ p_joint: 0.253, stake_sgp: 4.96 });
    expect(withHold).toBeCloseTo(withoutHold, 10);
    // 0.253 × 4.96 − 1 = +0.255 (the corrected few-shot example)
    expect(withHold).toBeCloseTo(0.255, 3);
  });

  it("falls back to legacy p_final / effective_sgp_price for old cached results", () => {
    // Backward-compat: pre-fix cached results carried the double-vig pair.
    expect(
      calculateSGPEV({
        p_final: 0.3,
        effective_sgp_price: 4.0,
      }),
    ).toBeCloseTo(0.2, 4);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// GROUP 2b — calculateKellyStake (bankroll engine, floors GONE)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe("calculateKellyStake", () => {
  it("caps and rounds DOWN when raw stake exceeds the 2.5% cap", () => {
    // full_kelly = 0.10/0.78 = 12.8%; fractional = 3.2%; raw = $16.03
    // cap = 500 * 0.025 = $12.50 → min(16.03,12.50)=12.50 → floor → 12
    const result = calculateKellyStake({
      ev: 0.1,
      decimal_odds: 1.78,
      bankroll: 500,
      fraction: 0.25,
      max_bet_pct: 0.025,
      min_actionable: 2,
    });
    expect(result.full_kelly_pct).toBeCloseTo(12.8, 1);
    expect(result.raw_stake).toBeCloseTo(16.03, 1);
    expect(result.recommended_stake).toBe(12);
    expect(result.capped).toBe(true);
  });

  it("skips when the Kelly stake is below the $2 minimum (edge too small)", () => {
    // full_kelly = 0.03/4 = 0.75%; fractional = 0.1875%; raw ≈ $0.94 → skip
    const result = calculateKellyStake({
      ev: 0.03,
      decimal_odds: 5.0,
      bankroll: 500,
      fraction: 0.25,
      max_bet_pct: 0.025,
      min_actionable: 2,
    });
    expect(result.raw_stake).toBeCloseTo(0.94, 1);
    expect(result.recommended_stake).toBe(0);
    expect(result.skipped_too_small).toBe(true);
  });

  it("sizes an in-range stake without capping", () => {
    // full_kelly = 0.06/0.8 = 7.5%; fractional = 1.875%; raw ≈ $9.38 → 9
    const result = calculateKellyStake({
      ev: 0.06,
      decimal_odds: 1.8,
      bankroll: 500,
      fraction: 0.25,
      max_bet_pct: 0.025,
      min_actionable: 2,
    });
    expect(result.raw_stake).toBeCloseTo(9.38, 1);
    expect(result.recommended_stake).toBe(9);
    expect(result.capped).toBe(false);
  });

  it("returns all zeros for negative EV", () => {
    const result = calculateKellyStake({
      ev: -0.02,
      decimal_odds: 1.9,
      bankroll: 500,
      fraction: 0.25,
      max_bet_pct: 0.025,
      min_actionable: 2,
    });
    expect(result.recommended_stake).toBe(0);
    expect(result.raw_stake).toBe(0);
    expect(result.skipped_too_small).toBe(false);
    expect(result.reasoning).toContain("Negative");
  });

  it("scales stakes down with a smaller bankroll", () => {
    // bankroll 100: raw = 3.2% of 100 = $3.21; cap = $2.50 → floor → 2
    const result = calculateKellyStake({
      ev: 0.1,
      decimal_odds: 1.78,
      bankroll: 100,
      fraction: 0.25,
      max_bet_pct: 0.025,
      min_actionable: 2,
    });
    expect(result.raw_stake).toBeCloseTo(3.21, 1);
    expect(result.recommended_stake).toBe(2);
    expect(result.capped).toBe(true);
  });
});


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// GROUP 3 — validateModelProbabilities
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe("validateModelProbabilities", () => {
  it("passes without normalization when sum is exactly 100", () => {
    const result = validateModelProbabilities({
      home: 45,
      draw: 30,
      away: 25,
    });
    expect(result.was_normalized).toBe(false);
    expect(result.raw_sum).toBe(100);
    expect(result.home).toBe(45);
  });

  it("normalizes when sum is off", () => {
    // Netherlands vs Morocco had this pattern in testing
    const result = validateModelProbabilities({
      home: 42,
      draw: 38,
      away: 22,
    });
    // sum = 102, should normalize
    expect(result.was_normalized).toBe(true);
    expect(result.home + result.draw + result.away).toBeCloseTo(100, 1);
  });

  it("passes within 0.5 tolerance", () => {
    const result = validateModelProbabilities({
      home: 33.5,
      draw: 33.2,
      away: 33.1,
    });
    // sum 99.8, within 0.5 tolerance
    expect(result.was_normalized).toBe(false);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// GROUP 4 — calculateEnsembleAlignment
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe("calculateEnsembleAlignment", () => {
  it("returns TRIPLE ALIGNED when all signals within 0.3", () => {
    const result = calculateEnsembleAlignment({
      signal_1_model: 2.4,
      signal_2_poisson: 2.3,
      signal_3_historical: 2.4,
    });
    expect(result.alignment).toBe("TRIPLE ALIGNED");
    expect(result.confidence_impact).toBe(5);
  });

  it("returns MAJORITY when 2 of 3 signals align within 0.3", () => {
    // France vs Sweden: 2.9/2.3/2.4
    // diff12=0.6, diff13=0.5, diff23=0.1
    // signals 2+3 within 0.3 → MAJORITY
    const result = calculateEnsembleAlignment({
      signal_1_model: 2.9,
      signal_2_poisson: 2.3,
      signal_3_historical: 2.4,
    });
    expect(result.alignment).toBe("MAJORITY");
    expect(result.confidence_impact).toBe(0);
  });

  it("returns CONFLICT when all signals diverge above 0.3", () => {
    const result = calculateEnsembleAlignment({
      signal_1_model: 3.5,
      signal_2_poisson: 2.0,
      signal_3_historical: 1.5,
    });
    expect(result.alignment).toBe("CONFLICT");
    expect(result.confidence_impact).toBe(-5);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// GROUP 5 — detectDeadRubber
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe("detectDeadRubber", () => {
  it("flags Tunisia correctly as dead rubber — 0pts, group complete, cutoff 3", () => {
    // Verified live tonight against real WC2026 standings data
    const result = detectDeadRubber({
      fixture_matchday: 3,
      fixture_date: "2026-06-25",
      opponent_team_id: "tm_tunisia",
      opponent_group_standings: [
        {
          team_id: "tm_tunisia",
          points: 0,
          position: 4,
          matches_played: 3,
          goal_difference: -10,
          goals_for: 0,
        },
        {
          team_id: "tm_netherlands",
          points: 7,
          position: 1,
          matches_played: 3,
          goal_difference: 8,
          goals_for: 9,
        },
        {
          team_id: "tm_other1",
          points: 4,
          position: 2,
          matches_played: 3,
          goal_difference: 2,
          goals_for: 4,
        },
        {
          team_id: "tm_other2",
          points: 4,
          position: 3,
          matches_played: 3,
          goal_difference: 0,
          goals_for: 3,
        },
      ],
      all_groups_third_place_table: [
        {
          team_id: "tm_ecuador",
          group_label: "E",
          points: 4,
          goal_difference: 0,
          goals_for: 2,
        },
        {
          team_id: "tm_drc",
          group_label: "A",
          points: 4,
          goal_difference: 1,
          goals_for: 3,
        },
        {
          team_id: "tm_sweden",
          group_label: "B",
          points: 4,
          goal_difference: 0,
          goals_for: 2,
        },
        {
          team_id: "tm_ghana",
          group_label: "C",
          points: 4,
          goal_difference: 0,
          goals_for: 2,
        },
        {
          team_id: "tm_bosnia",
          group_label: "D",
          points: 4,
          goal_difference: 0,
          goals_for: 2,
        },
        {
          team_id: "tm_algeria",
          group_label: "G",
          points: 4,
          goal_difference: 0,
          goals_for: 2,
        },
        {
          team_id: "tm_paraguay",
          group_label: "H",
          points: 4,
          goal_difference: 0,
          goals_for: 2,
        },
        {
          team_id: "tm_senegal",
          group_label: "I",
          points: 3,
          goal_difference: 1,
          goals_for: 2,
        },
      ],
      group_total_matchdays: 3,
    });
    expect(result.is_dead_rubber).toBe(true);
  });

  it("does NOT flag Ecuador as dead rubber — 4pts, 3rd, group complete, cutoff 3", () => {
    // Ecuador verified NOT flagged correctly tonight
    const result = detectDeadRubber({
      fixture_matchday: 3,
      fixture_date: "2026-06-25",
      opponent_team_id: "tm_ecuador",
      opponent_group_standings: [
        {
          team_id: "tm_ecuador",
          points: 4,
          position: 3,
          matches_played: 3,
          goal_difference: 0,
          goals_for: 2,
        },
        {
          team_id: "tm_germany",
          points: 6,
          position: 1,
          matches_played: 3,
          goal_difference: 6,
          goals_for: 10,
        },
        {
          team_id: "tm_other1",
          points: 5,
          position: 2,
          matches_played: 3,
          goal_difference: 2,
          goals_for: 5,
        },
        {
          team_id: "tm_other2",
          points: 1,
          position: 4,
          matches_played: 3,
          goal_difference: -8,
          goals_for: 1,
        },
      ],
      all_groups_third_place_table: [
        {
          team_id: "tm_drc",
          group_label: "A",
          points: 4,
          goal_difference: 1,
          goals_for: 3,
        },
        {
          team_id: "tm_sweden",
          group_label: "B",
          points: 4,
          goal_difference: 0,
          goals_for: 2,
        },
        {
          team_id: "tm_ghana",
          group_label: "C",
          points: 4,
          goal_difference: 0,
          goals_for: 2,
        },
        {
          team_id: "tm_bosnia",
          group_label: "D",
          points: 4,
          goal_difference: 0,
          goals_for: 2,
        },
        {
          team_id: "tm_algeria",
          group_label: "G",
          points: 4,
          goal_difference: 0,
          goals_for: 2,
        },
        {
          team_id: "tm_paraguay",
          group_label: "H",
          points: 4,
          goal_difference: 0,
          goals_for: 2,
        },
        {
          team_id: "tm_senegal",
          group_label: "I",
          points: 3,
          goal_difference: 1,
          goals_for: 2,
        },
        {
          team_id: "tm_iran",
          group_label: "J",
          points: 3,
          goal_difference: 0,
          goals_for: 2,
        },
      ],
      group_total_matchdays: 3,
    });
    expect(result.is_dead_rubber).toBe(false);
  });

  it("does NOT flag a match where group is not yet complete", () => {
    // matchday 2 of 3 — still live
    const result = detectDeadRubber({
      fixture_matchday: 2,
      fixture_date: "2026-06-20",
      opponent_team_id: "tm_test",
      opponent_group_standings: [
        {
          team_id: "tm_test",
          points: 0,
          position: 4,
          matches_played: 2,
          goal_difference: -5,
          goals_for: 0,
        },
        {
          team_id: "tm_other1",
          points: 6,
          position: 1,
          matches_played: 2,
          goal_difference: 5,
          goals_for: 6,
        },
        {
          team_id: "tm_other2",
          points: 3,
          position: 2,
          matches_played: 2,
          goal_difference: 1,
          goals_for: 3,
        },
        {
          team_id: "tm_other3",
          points: 3,
          position: 3,
          matches_played: 2,
          goal_difference: -1,
          goals_for: 2,
        },
      ],
      all_groups_third_place_table: [],
      group_total_matchdays: 3,
    });
    expect(result.is_dead_rubber).toBe(false);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// GROUP 6 — adjustEVForPinnacleGap
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe("adjustEVForPinnacleGap", () => {
  it("returns MEDIUM confidence and reduces EV when Stake is more than 5% better than Pinnacle", () => {
    const result = adjustEVForPinnacleGap({
      raw_ev: 0.12,
      stake_odds: 2.2,
      pinnacle_odds: 2.0,
      // gap = (2.20/2.00 - 1)*100 = 10% > 5% → reduce EV by 15%
    });
    expect(result.ev_confidence).toBe("MEDIUM");
    expect(result.adjusted_ev).toBeCloseTo(0.12 * 0.85, 4);
  });

  it("returns HIGH confidence and UNCHANGED EV when Stake is worse than Pinnacle (FIX 4)", () => {
    const result = adjustEVForPinnacleGap({
      raw_ev: 0.08,
      stake_odds: 1.95,
      pinnacle_odds: 2.05,
      // gap = (1.95/2.05 - 1)*100 = -4.9% < -3% → confidence up, EV unchanged
    });
    expect(result.ev_confidence).toBe("HIGH");
    expect(result.adjusted_ev).toBeCloseTo(0.08, 4);
  });

  it("FIX 4: raw_ev 0.10, stake 1.70, pinnacle 1.80 → adjusted_ev 0.10 exactly, HIGH", () => {
    const result = adjustEVForPinnacleGap({
      raw_ev: 0.1,
      stake_odds: 1.7,
      pinnacle_odds: 1.8,
    });
    expect(result.adjusted_ev).toBeCloseTo(0.1, 4);
    expect(result.ev_confidence).toBe("HIGH");
  });

  it("returns MEDIUM and unchanged EV when Pinnacle is null", () => {
    const result = adjustEVForPinnacleGap({
      raw_ev: 0.1,
      stake_odds: 2.0,
      pinnacle_odds: null,
    });
    expect(result.ev_confidence).toBe("MEDIUM");
    expect(result.adjusted_ev).toBe(0.1);
  });

  it("returns HIGH confidence when Stake and Pinnacle are within 5% of each other", () => {
    const result = adjustEVForPinnacleGap({
      raw_ev: 0.08,
      stake_odds: 2.0,
      pinnacle_odds: 1.98,
      // gap = ~1% — within 5%
    });
    expect(result.ev_confidence).toBe("HIGH");
    expect(result.adjusted_ev).toBe(0.08);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// GROUP 7 — validateDimensionWeights
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe("validateDimensionWeights", () => {
  it("passes when weights sum to 100 and match expected conditions", () => {
    // France vs Sweden from tonight:
    // D1 40 D2 25 D3 20 D4 5 D5 5 D6 5 = 100, H2H gate passed
    const result = validateDimensionWeights({
      weights: {
        D1: 40,
        D2: 25,
        D3: 20,
        D4: 5,
        D5: 5,
        D6: 5,
      },
      call4_fixture_count: 5,
      h2h_gate_passed: true,
      critical_absence_present: false,
      all_players_confirmed_fit: true,
    });
    expect(result.sum_valid).toBe(true);
    expect(result.mismatch_flags.length).toBe(0);
  });

  it("flags sum=90 as Netherlands vs Morocco case from tonight", () => {
    // D1 40 D2 15 D3 20 D4 10 D5 5 D6 0 = 90 — caught by validator
    const result = validateDimensionWeights({
      weights: {
        D1: 40,
        D2: 15,
        D3: 20,
        D4: 10,
        D5: 5,
        D6: 0,
      },
      call4_fixture_count: 5,
      h2h_gate_passed: false,
      critical_absence_present: false,
      all_players_confirmed_fit: false,
    });
    expect(result.sum_valid).toBe(false);
    expect(result.mismatch_flags.some((f) => f.includes("90"))).toBe(true);
  });

  it("sets validation_ran false when weights object is null", () => {
    // The else branch added tonight for missing dimension_weights
    const result = validateDimensionWeights({
      weights: null,
      call4_fixture_count: 5,
      h2h_gate_passed: true,
      critical_absence_present: false,
      all_players_confirmed_fit: false,
    });
    expect(result.validation_ran).toBe(false);
    expect(result.mismatch_flags.length).toBeGreaterThan(0);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// GROUP 8 — EV gate in calculateResults
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe("EV gate in calculateResults", () => {
  it("forces bet_1 inactive when computed EV is negative", () => {
    // Simulates France vs Sweden
    // Bet 1: Over 2.5 @ 1.38, model 56.5% → EV -0.220
    const mockOutput = {
      bet_1: {
        active: true,
        ev_inputs: {
          model_probability: 0.565,
          decimal_odds: 1.38,
        },
        ev_rating: "MARGINAL",
      },
      bet_3: {
        active: false,
        parlay_ev_inputs: {
          p_final: 0,
          effective_sgp_price: 0,
        },
      },
      bet_4: {
        active: false,
        jackpot_ev_inputs: {
          p_final: 0,
          combined_odds: 0,
        },
      },
    };
    const result = calculateResults(mockOutput);
    expect(result.bet_1?.active).toBe(false);
    expect(result.bet_1?.ev_rating).toBe("NEGATIVE");
  });

  it("forces bet_3 (SGP) inactive when parlay EV is negative", () => {
    // Norway vs Ivory Coast parlay:
    // p_final 0.133, effective 4.54 → EV = -0.396
    const mockOutput = {
      bet_1: {
        active: false,
        ev_inputs: {
          model_probability: 0,
          decimal_odds: 0,
        },
      },
      bet_3: {
        active: true,
        parlay_ev_inputs: {
          p_final: 0.133,
          effective_sgp_price: 4.54,
        },
        ev_rating: "MARGINAL",
      },
      bet_4: {
        active: false,
        jackpot_ev_inputs: {
          p_final: 0,
          combined_odds: 0,
        },
      },
    };
    const result = calculateResults(mockOutput);
    expect(result.bet_3?.active).toBe(false);
    expect(result.bet_3?.ev_rating).toBe("NEGATIVE");
  });

  it("keeps bet active when EV is genuinely positive", () => {
    const mockOutput = {
      bet_1: {
        active: true,
        ev_inputs: {
          model_probability: 0.56,
          decimal_odds: 2.0,
          // EV = 0.12 — positive
        },
        ev_rating: "STRONG",
      },
      bet_3: {
        active: false,
        parlay_ev_inputs: {
          p_final: 0,
          effective_sgp_price: 0,
        },
      },
      bet_4: {
        active: false,
        jackpot_ev_inputs: {
          p_final: 0,
          combined_odds: 0,
        },
      },
    };
    const result = calculateResults(mockOutput);
    expect(result.bet_1?.active).toBe(true);
    expect(result.bet_1?.ev_rating).not.toBe("NEGATIVE");
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// GROUP 9 — applyDeadRubberDiscount
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe("applyDeadRubberDiscount", () => {
  it("applies 0.2x weight to dead rubber fixtures", () => {
    const result = applyDeadRubberDiscount([
      {
        goals_scored: 4,
        shots_on_target: 8,
        is_dead_rubber: true,
        is_group_stage: true,
      },
      {
        goals_scored: 2,
        shots_on_target: 5,
        is_dead_rubber: false,
        is_group_stage: true,
      },
      {
        goals_scored: 3,
        shots_on_target: 6,
        is_dead_rubber: false,
        is_group_stage: false,
      },
    ]);
    expect(result.dead_rubber_count).toBe(1);
    // Dead rubber: 4 * 0.2 = 0.8
    // Group stage: 2 * 0.4 = 0.8
    // Knockout: 3 * 1.0 = 3.0
    // Total weight: 0.2 + 0.4 + 1.0 = 1.6
    // Avg goals: (0.8+0.8+3.0)/1.6 = 2.875
    expect(result.adjusted_goals_avg).toBeCloseTo(2.875, 2);
  });

  it("applies 0.4x weight to non-dead rubber group stage fixtures", () => {
    const result = applyDeadRubberDiscount([
      {
        goals_scored: 2,
        shots_on_target: 4,
        is_dead_rubber: false,
        is_group_stage: true,
      },
      {
        goals_scored: 2,
        shots_on_target: 4,
        is_dead_rubber: false,
        is_group_stage: true,
      },
    ]);
    expect(result.dead_rubber_count).toBe(0);
    expect(result.adjusted_goals_avg).toBeCloseTo(2.0, 4);
  });

  it("handles empty fixture array without throwing", () => {
    const result = applyDeadRubberDiscount([]);
    expect(result.adjusted_goals_avg).toBe(0);
    expect(result.dead_rubber_count).toBe(0);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// GROUP 10 — bettingGlossary
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe("bettingGlossary", () => {
  it("resolves Asian Handicap from Claude market name", () => {
    expect(resolveMarketType("Asian Handicap")).toBe("ASIAN_HANDICAP");
    expect(resolveMarketType("asian handicap")).toBe("ASIAN_HANDICAP");
    // resolveMarketType lowercases input, so all-caps resolves too (case-insensitive by design).
    expect(resolveMarketType("ASIAN HANDICAP")).toBe("ASIAN_HANDICAP");
  });

  it("generates correct stake label for Asian Handicap", () => {
    const label = generateStakeLabel(
      "ASIAN_HANDICAP",
      "Spain -1",
      "Spain",
      "Austria",
    );
    expect(label).toContain("Asian Handicap");
    expect(label).toContain("Spain vs Austria");
    expect(label).toContain("Spain -1");
    expect(label).toContain("90 minutes");
    expect(label).toContain("Eliminates the draw");
  });

  it("generates correct label for Asian Total with warning", () => {
    const label = generateStakeLabel(
      "ASIAN_TOTAL",
      "Over 2.25 Goals",
      "Spain",
      "Austria",
    );
    expect(label).toContain("Asian Total");
    expect(label).toContain("NOT the same as Exact Goals");
  });

  it("generates correct label for Same Game Multi", () => {
    const label = generateStakeLabel(
      "SAME_GAME_MULTI",
      "3-leg multi",
      "Spain",
      "Austria",
    );
    expect(label).toContain("Bet Builder tab");
    expect(label).toContain("Minimum 3 legs");
  });

  it("resolves BTTS variants", () => {
    expect(resolveMarketType("btts")).toBe("BTTS");
    expect(resolveMarketType("both teams to score")).toBe("BTTS");
    expect(resolveMarketType("both teams score")).toBe("BTTS");
  });

  it("resolves knockout markets", () => {
    expect(resolveMarketType("team to qualify")).toBe("TEAM_TO_QUALIFY");
    expect(resolveMarketType("to advance")).toBe("TEAM_TO_QUALIFY");
    expect(resolveMarketType("et yes")).toBe("MATCH_EXTRA_TIME");
    expect(resolveMarketType("pens yes")).toBe("MATCH_PENALTIES");
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// GROUP 11 — bankroll engine: exposure cap + totals (A3)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe("bankroll exposure cap in calculateResults", () => {
  const mk = () => ({
    match: "USA vs Bosnia",
    // ev ≈ 0.10 at odds 1.78 → Kelly raw $16.03, capped at 2.5% = $12 each
    bet_1: {
      active: true,
      ev_inputs: { model_probability: 0.618, decimal_odds: 1.78 },
    },
    bet_2: {
      active: true,
      ev_inputs: { model_probability: 0.618, decimal_odds: 1.78 },
    },
    bet_3: { active: true, parlay_ev_inputs: { p_joint: 0.3, stake_sgp: 4.0 } },
    bet_4: {
      active: true,
      jackpot_ev_inputs: { p_final: 0.2, combined_odds: 6.0 },
    },
  });

  it("drops bet_4 then bet_3 to satisfy the 5% cap, leaving bet_1 untouched", () => {
    const result = calculateResults(mk(), { bankroll: 500 });
    expect(result.bet_1?.active).toBe(true);
    expect(result.bet_1?.stake).toBe("$12");
    expect(result.bet_2?.active).toBe(true);
    expect(result.bet_4?.active).toBe(false);
    expect(result.bet_3?.active).toBe(false);
    expect(result.match_exposure_cap_triggered).toBe(true);
  });

  it("total_staked equals the exact sum of displayed active stakes", () => {
    const result = calculateResults(mk(), { bankroll: 500 });
    const parseNum = (s?: string) =>
      Number.parseFloat(String(s ?? "").replace(/[^0-9.]/g, "")) || 0;
    let sum = 0;
    for (const b of [result.bet_1, result.bet_2, result.bet_3, result.bet_4]) {
      if (b?.active) sum += parseNum(b.stake);
    }
    expect(result.total_staked).toBe(`$${sum.toFixed(2)}`);
  });

  it("sets unallocated_stake to the bankroll-sizing sentinel", () => {
    const result = calculateResults(mk(), { bankroll: 500 });
    expect(result.unallocated_stake).toBe("N/A — bankroll sizing");
  });

  it("scales stakes down with a smaller bankroll (bankroll 100)", () => {
    const result = calculateResults(mk(), { bankroll: 100 });
    // cap per bet = 2.5% of 100 = $2.50 → floor → $2
    expect(result.bet_1?.stake).toBe("$2");
    expect(result.bankroll_at_analysis).toBe(100);
  });
});


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// GROUP 12 — Part B fixes (FIX 1, FIX 3, FIX 6)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe("FIX 1 — confidence no double-count", () => {
  it("counts the ensemble/conflict delta once, keeps unrelated adjustments", () => {
    const conf = computeConfidence(
      {
        dimension_weighted_raw: 72,
        adjustments: [
          { type: "3_signal_conflict", delta: -5 },
          { type: "xG_proxy_used", delta: -3 },
        ],
      },
      { signal_1_model: 1.95, signal_2_poisson: 2.3, signal_3_historical: 2.4 },
    );
    // signals 1.95/2.3/2.4 → MAJORITY (impact 0). App DROPS Claude's -5 conflict
    // (no double-count) and injects its own 0: 72 - 3 (xG survives) + 0 = 69.
    expect(conf?.post_adjustment).toBe(69);
    // The single injected ensemble delta replaces any Claude-supplied one.
    expect(
      conf?.adjustments.filter((a) =>
        /ensemble|signal|conflict|aligned|poisson/i.test(a.type ?? ""),
      ).length,
    ).toBe(1);
  });
});

describe("FIX 3 — resolveMarketType progressive matching", () => {
  it("resolves parenthetical + variant names", () => {
    expect(resolveMarketType("Goal Totals (Over/Under)")).toBe("GOAL_TOTALS");
    expect(resolveMarketType("Moneyline (3-way)")).toBe("MONEYLINE_3WAY");
    expect(resolveMarketType("Total Goals Over/Under 2.5")).toBe("GOAL_TOTALS");
    expect(resolveMarketType("Asian Handicap -1")).toBe("ASIAN_HANDICAP");
    expect(resolveMarketType("unknown market")).toBeNull();
  });
});

describe("FIX 6 — detectDeadRubber requires pre-match rows", () => {
  const thirdField = [
    { team_id: "x1", group_label: "B", points: 4, goal_difference: 1, goals_for: 3 },
    { team_id: "x2", group_label: "C", points: 4, goal_difference: 0, goals_for: 2 },
    { team_id: "x3", group_label: "D", points: 3, goal_difference: 0, goals_for: 2 },
  ];

  it("(c) opponent 6 pts pre-match, rivals max 3/4/4 → dead rubber TRUE", () => {
    const r = detectDeadRubber({
      fixture_matchday: 3,
      fixture_date: "2026-06-27T18:00:00+00:00",
      opponent_team_id: "opp",
      opponent_group_standings: [
        { team_id: "opp", points: 6, position: 1, matches_played: 2, goal_difference: 4, goals_for: 6 },
        { team_id: "r1", points: 3, position: 2, matches_played: 2, goal_difference: 0, goals_for: 2 },
        { team_id: "r2", points: 1, position: 3, matches_played: 2, goal_difference: -2, goals_for: 1 },
        { team_id: "r3", points: 1, position: 4, matches_played: 2, goal_difference: -2, goals_for: 1 },
      ],
      all_groups_third_place_table: thirdField,
      group_total_matchdays: 3,
    });
    expect(r.is_dead_rubber).toBe(true);
  });

  it("(d) opponent 3 pts pre-match with a live rival → FALSE (old bug)", () => {
    const r = detectDeadRubber({
      fixture_matchday: 3,
      fixture_date: "2026-06-27T18:00:00+00:00",
      opponent_team_id: "opp",
      opponent_group_standings: [
        { team_id: "lead", points: 6, position: 1, matches_played: 2, goal_difference: 4, goals_for: 6 },
        { team_id: "opp", points: 3, position: 2, matches_played: 2, goal_difference: 0, goals_for: 3 },
        { team_id: "rival", points: 3, position: 3, matches_played: 2, goal_difference: 0, goals_for: 2 },
        { team_id: "r3", points: 0, position: 4, matches_played: 2, goal_difference: -4, goals_for: 0 },
      ],
      all_groups_third_place_table: thirdField,
      group_total_matchdays: 3,
    });
    expect(r.is_dead_rubber).toBe(false);
  });

  it("(e) opponent 0 pts, cross-group cutoff 4 → best case 3 < 4 → TRUE", () => {
    const r = detectDeadRubber({
      fixture_matchday: 3,
      fixture_date: "2026-06-27T18:00:00+00:00",
      opponent_team_id: "opp",
      opponent_group_standings: [
        { team_id: "a", points: 6, position: 1, matches_played: 2, goal_difference: 4, goals_for: 6 },
        { team_id: "b", points: 4, position: 2, matches_played: 2, goal_difference: 2, goals_for: 4 },
        { team_id: "opp", points: 0, position: 3, matches_played: 2, goal_difference: -6, goals_for: 0 },
        { team_id: "d", points: 3, position: 4, matches_played: 2, goal_difference: 0, goals_for: 2 },
      ],
      all_groups_third_place_table: [
        { team_id: "z1", group_label: "B", points: 4, goal_difference: 1, goals_for: 3 },
        { team_id: "z2", group_label: "C", points: 4, goal_difference: 0, goals_for: 2 },
      ],
      group_total_matchdays: 3,
    });
    expect(r.is_dead_rubber).toBe(true);
  });
});
