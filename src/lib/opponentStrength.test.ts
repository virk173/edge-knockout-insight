import { describe, it, expect } from "vitest";
import { computeOpponentStrengthMultiplier } from "./analyse";
import {
  computeGapScore,
  clampOpponentStrengthMultiplier,
} from "./calculate";

// ─────────────────────────────────────────────────────────────
// EDGE-FIX tier 8.1 — GAP-3 opponent-strength weighting
// Player stats are tournament aggregates, so the app weights the TEAM's goals
// in each completed fixture by the opponent's FINAL group position (top-2
// ×1.0, 3rd ×0.8, 4th ×0.6) and applies the goal-weighted average to the
// goals/assists terms of the gap score. Claude only copies the value;
// calculate.ts clamps it so a hallucination can never inflate a gap.
// ─────────────────────────────────────────────────────────────

const groupRows = [
  { team_id: "t1", team_name: "France", points: 9, position: 1, matches_played: 3, goal_difference: 6, goals_for: 7, group_label: "D" },
  { team_id: "t2", team_name: "Denmark", points: 6, position: 2, matches_played: 3, goal_difference: 2, goals_for: 4, group_label: "D" },
  { team_id: "t3", team_name: "Tunisia", points: 3, position: 3, matches_played: 3, goal_difference: -2, goals_for: 2, group_label: "D" },
  { team_id: "t4", team_name: "Niger", points: 0, position: 4, matches_played: 3, goal_difference: -6, goals_for: 1, group_label: "D" },
];

// API-Football completed-fixtures shape (getCompletedFixtures output items).
const fx = (
  homeId: number,
  homeName: string,
  awayId: number,
  awayName: string,
  gh: number,
  ga: number,
) => ({
  teams: { home: { id: homeId, name: homeName }, away: { id: awayId, name: awayName } },
  goals: { home: gh, away: ga },
});

describe("tier 8.1 — computeOpponentStrengthMultiplier", () => {
  it("weights team goals by opponent final group position (goal-weighted average)", () => {
    const completed = [
      fx(100, "France", 400, "Niger", 3, 0), // 3 goals vs 4th → ×0.6
      fx(200, "Denmark", 100, "France", 1, 1), // 1 goal vs 2nd → ×1.0
      fx(100, "France", 300, "Tunisia", 0, 0), // 0 goals vs 3rd
    ];
    const r = computeOpponentStrengthMultiplier(completed, 100, groupRows);
    expect(r).not.toBeNull();
    expect(r!.fixtures_counted).toBe(3);
    expect(r!.raw_goals).toBe(4);
    // (3×0.6 + 1×1.0 + 0×0.8) / 4 = 2.8 / 4 = 0.7
    expect(r!.multiplier).toBe(0.7);
    const niger = r!.breakdown.find((b) => b.opponent === "Niger");
    expect(niger!.weight).toBe(0.6);
    expect(niger!.opponent_final_group_position).toBe(4);
  });

  it("all goals against top-2 finishers → neutral 1.0 (no discount)", () => {
    const completed = [fx(100, "France", 200, "Denmark", 2, 0)];
    const r = computeOpponentStrengthMultiplier(completed, 100, groupRows);
    expect(r!.multiplier).toBe(1.0);
  });

  it("team scored zero tournament goals → nothing to weight, neutral 1.0", () => {
    const completed = [fx(100, "France", 400, "Niger", 0, 2)];
    const r = computeOpponentStrengthMultiplier(completed, 100, groupRows);
    expect(r!.multiplier).toBe(1.0);
    expect(r!.raw_goals).toBe(0);
  });

  it("unresolvable opponent name gets a neutral ×1.0 weight, never a discount", () => {
    const completed = [
      fx(100, "France", 999, "Atlantis", 2, 0), // not in standings
      fx(100, "France", 400, "Niger", 2, 0),
    ];
    const r = computeOpponentStrengthMultiplier(completed, 100, groupRows);
    // (2×1.0 + 2×0.6) / 4 = 0.8
    expect(r!.multiplier).toBe(0.8);
    const unknown = r!.breakdown.find((b) => b.opponent === "Atlantis");
    expect(unknown!.opponent_final_group_position).toBeNull();
    expect(unknown!.weight).toBe(1.0);
  });

  it("no standings or no fixtures for the team → null (field omitted upstream)", () => {
    expect(computeOpponentStrengthMultiplier([fx(1, "A", 2, "B", 1, 0)], 1, [])).toBeNull();
    expect(computeOpponentStrengthMultiplier([], 100, groupRows)).toBeNull();
    expect(
      computeOpponentStrengthMultiplier([fx(1, "A", 2, "B", 1, 0)], 100, groupRows),
    ).toBeNull();
  });

  it("result is always inside [0.6, 1.0] — the weight floor bounds it", () => {
    const completed = [fx(100, "France", 400, "Niger", 5, 0)];
    const r = computeOpponentStrengthMultiplier(completed, 100, groupRows);
    expect(r!.multiplier).toBe(0.6);
  });
});

describe("tier 8.1 — computeGapScore applies the multiplier to goals/assists only", () => {
  const base = {
    actual_goals: 2,
    actual_assists: 1,
    shots_pg_delta: 1.9,
    keypasses_pg_delta: 1.3,
    set_piece_weight: 10,
  };
  // Unweighted terms: shots 1.9×7 = 13.3, kp 1.3×5 = 6.5, set piece 10.
  const nonGoalTerms = 13.3 + 6.5 + 10;

  it("absent multiplier → identical to the historical formula (×1.0)", () => {
    expect(computeGapScore(base)).toBe(
      Math.round((2 * 8 + 1 * 5 + nonGoalTerms) * 10) / 10,
    );
  });

  it("multiplier discounts ONLY the goals/assists terms", () => {
    const gap = computeGapScore({ ...base, opponent_strength_multiplier: 0.85 });
    expect(gap).toBe(Math.round(((2 * 8 + 1 * 5) * 0.85 + nonGoalTerms) * 10) / 10);
  });

  it("clamps a hallucinated value: below 0.6 → 0.6, above 1.0 → 1.0", () => {
    expect(clampOpponentStrengthMultiplier(0.3)).toBe(0.6);
    expect(clampOpponentStrengthMultiplier(1.4)).toBe(1);
    expect(clampOpponentStrengthMultiplier(undefined)).toBe(1);
    const inflated = computeGapScore({ ...base, opponent_strength_multiplier: 1.4 });
    expect(inflated).toBe(computeGapScore(base));
  });
});
