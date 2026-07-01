import { describe, it, expect } from "vitest";
import {
  calculateEV,
  calculateSGPEV,
  validateModelProbabilities,
  calculateEnsembleAlignment,
  detectDeadRubber,
  adjustEVForPinnacleGap,
  validateDimensionWeights,
  calculateResults,
  applyDeadRubberDiscount,
} from "@/lib/calculate";

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
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe("calculateSGPEV", () => {
  it("returns negative EV for Norway vs Ivory Coast SGP from tonight", () => {
    // p_final 0.133, effective_sgp 4.54
    // EV = 0.133 * 4.54 - 1 = -0.396
    // This is the parlay the EV gate correctly killed tonight
    expect(
      calculateSGPEV({
        p_final: 0.133,
        effective_sgp_price: 4.54,
      }),
    ).toBeCloseTo(-0.396, 2);
  });

  it("returns negative EV for France vs Sweden SGP from tonight", () => {
    // p_final 0.169, effective 3.57
    // EV = 0.169 * 3.57 - 1 = -0.397
    expect(
      calculateSGPEV({
        p_final: 0.169,
        effective_sgp_price: 3.57,
      }),
    ).toBeCloseTo(-0.397, 2);
  });

  it("returns positive EV for a genuinely good parlay", () => {
    // p_final 0.30, effective 4.00
    // EV = 0.30 * 4.00 - 1 = 0.20
    expect(
      calculateSGPEV({
        p_final: 0.3,
        effective_sgp_price: 4.0,
      }),
    ).toBeCloseTo(0.2, 4);
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

  it("returns HIGH confidence and increases EV when Stake is worse than Pinnacle", () => {
    const result = adjustEVForPinnacleGap({
      raw_ev: 0.08,
      stake_odds: 1.95,
      pinnacle_odds: 2.05,
      // gap = (1.95/2.05 - 1)*100 = -4.9% < -3% → increase 10%
    });
    expect(result.ev_confidence).toBe("HIGH");
    expect(result.adjusted_ev).toBeCloseTo(0.08 * 1.1, 4);
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
  it("forces tier_1 inactive when computed EV is negative", () => {
    // Simulates France vs Sweden
    // Tier 1: Over 2.5 @ 1.38, model 56.5% → EV -0.220
    const mockOutput = {
      tier_1_anchor: {
        active: true,
        ev_inputs: {
          model_probability: 0.565,
          decimal_odds: 1.38,
        },
        ev_rating: "MARGINAL",
      },
      tier_2_parlay: {
        active: false,
        parlay_ev_inputs: {
          p_final: 0,
          effective_sgp_price: 0,
        },
      },
      tier_3_jackpot: {
        active: false,
        jackpot_ev_inputs: {
          p_final: 0,
          combined_odds: 0,
        },
      },
    };
    const result = calculateResults(mockOutput);
    expect(result.tier_1_anchor?.active).toBe(false);
    expect(result.tier_1_anchor?.ev_rating).toBe("NEGATIVE");
  });

  it("forces tier_2 inactive when parlay EV is negative", () => {
    // Norway vs Ivory Coast parlay:
    // p_final 0.133, effective 4.54 → EV = -0.396
    const mockOutput = {
      tier_1_anchor: {
        active: false,
        ev_inputs: {
          model_probability: 0,
          decimal_odds: 0,
        },
      },
      tier_2_parlay: {
        active: true,
        parlay_ev_inputs: {
          p_final: 0.133,
          effective_sgp_price: 4.54,
        },
        ev_rating: "MARGINAL",
      },
      tier_3_jackpot: {
        active: false,
        jackpot_ev_inputs: {
          p_final: 0,
          combined_odds: 0,
        },
      },
    };
    const result = calculateResults(mockOutput);
    expect(result.tier_2_parlay?.active).toBe(false);
    expect(result.tier_2_parlay?.ev_rating).toBe("NEGATIVE");
  });

  it("keeps tier active when EV is genuinely positive", () => {
    const mockOutput = {
      tier_1_anchor: {
        active: true,
        ev_inputs: {
          model_probability: 0.56,
          decimal_odds: 2.0,
          // EV = 0.12 — positive
        },
        ev_rating: "STRONG",
      },
      tier_2_parlay: {
        active: false,
        parlay_ev_inputs: {
          p_final: 0,
          effective_sgp_price: 0,
        },
      },
      tier_3_jackpot: {
        active: false,
        jackpot_ev_inputs: {
          p_final: 0,
          combined_odds: 0,
        },
      },
    };
    const result = calculateResults(mockOutput);
    expect(result.tier_1_anchor?.active).toBe(true);
    expect(result.tier_1_anchor?.ev_rating).not.toBe("NEGATIVE");
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
