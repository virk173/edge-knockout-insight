import { describe, it, expect } from "vitest";
import { buildLogEntryFromEnriched } from "@/lib/backtestLog";
import type { AnalysisResult } from "@/lib/analysisResult";

// Minimal helper to build an AnalysisResult-shaped object for these tests.
function makeResult(partial: Partial<AnalysisResult>): AnalysisResult {
  return {
    match: "Spain vs Austria",
    kickoff_UTC: "2026-06-20T19:00:00Z",
    round: "Group Stage",
    ensemble_check: { alignment: "MAJORITY" },
    confidence_scores: { adjustments: [], final_confidence: 62 },
    player_intelligence: { absences: [] },
    markets_evaluated: [],
    markets_rejected: [],
    bet_1: {},
    bet_2: {},
    bet_3: { legs: [] },
    bet_4: { legs: [] },
    ...partial,
  } as AnalysisResult;
}

describe("FIX 1 — backtest log uses app-computed values", () => {
  it("all bets inactive → 0 recommendations, records the match", () => {
    const result = makeResult({
      bet_1: { active: false, paper_bet: false, ev: -0.045 },
      bet_2: { active: false, paper_bet: false, ev: -0.03 },
      bet_3: { active: false, paper_bet: false, legs: [] },
      bet_4: { active: false, paper_bet: false, legs: [] },
      // Claude falsely claimed positive EV here — must be ignored entirely.
      log_entry: {
        notes: "Great value everywhere",
        recommendations: [
          { market: "Match Winner", ev: 0.054, stake: "$20" },
        ],
      },
    });

    const entry = buildLogEntryFromEnriched(result, { matchId: 123 });
    expect(entry.recommendations).toHaveLength(0);
    expect(entry.notes).toBe("No qualifying bets — all EV negative or gated.");
    expect(entry.match).toBe("Spain vs Austria");
    expect(entry.matchId).toBe(123);
  });

  it("one active bet → 1 recommendation carrying app ev + stake, not Claude's", () => {
    const result = makeResult({
      bet_1: {
        active: true,
        paper_bet: false,
        market: "Over 2.5 Goals",
        selection: "Over",
        odds: 1.95,
        stake: "$18.00", // app-sized Kelly stake
        model_probability: 0.55, // calibrated
        ev: -0.045, // app-computed (negative but bet flagged active in this test)
      },
      log_entry: {
        notes: "sizing note",
        recommendations: [{ market: "Over 2.5 Goals", ev: 0.072, stake: "$50" }],
      },
    });

    const entry = buildLogEntryFromEnriched(result, { matchId: 7 });
    expect(entry.recommendations).toHaveLength(1);
    const rec = entry.recommendations[0];
    expect(rec.ev).toBe(-0.045); // app value, NOT Claude's 0.072
    expect(rec.stake).toBe("$18.00"); // app stake, NOT Claude's $50
    expect(rec.model_probability).toBe(0.55);
    expect(rec.confidence).toBe(62); // app final_confidence
    expect(rec.ensemble_alignment).toBe("MAJORITY");
    expect(rec.paper).toBe(false);
    expect(entry.notes).toBe("Claude note: sizing note");
  });

  it("paper bets are included; fully inactive excluded", () => {
    const result = makeResult({
      bet_1: { active: false, paper_bet: true, market: "BTTS", stake: "$0", ev: 0.01 },
      bet_2: { active: false, paper_bet: false, market: "AH", ev: -0.1 },
      bet_3: {
        active: true,
        paper_bet: false,
        bet_type: "Same Game Parlay (3-Leg Accumulator)",
        legs: [
          { market: "Over 2.5", selection: "Over" },
          { market: "BTTS", selection: "Yes" },
        ],
        combined_odds_sgp: 3.1,
        p_joint: 0.34,
        parlay_ev: 0.05,
        stake: "$5",
      },
    });

    const entry = buildLogEntryFromEnriched(result);
    expect(entry.recommendations).toHaveLength(2);
    const paper = entry.recommendations.find((r) => r.tier === 1);
    expect(paper?.paper).toBe(true);
    const sgp = entry.recommendations.find((r) => r.tier === 3);
    expect(sgp?.odds).toBe(3.1);
    expect(sgp?.ev).toBe(0.05);
    expect(sgp?.selection).toContain("Over 2.5: Over");
  });
});
