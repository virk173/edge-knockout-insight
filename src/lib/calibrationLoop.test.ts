import { describe, it, expect } from "vitest";
import {
  getCalibrationSamples,
  buildLogEntryFromEnriched,
  computeSummary,
  computeEvRealised,
  cycleOutcome,
  type LogEntry,
  type LogRecommendation,
} from "./backtestLog";
import { fitLambda, DEFAULT_LAMBDA } from "./calibration";
import type { AnalysisResult } from "./analysisResult";

// EDGE-FIX tier 1 — the λ fit must run on RAW (pre-calibration) probabilities.
// Before this fix, samples stored the CALIBRATED probability: each refit saw
// already-shrunk inputs, found a λ closer to 1.0, and calibration silently
// disabled itself while the fitted λ was applied to raw probabilities.

function entryWith(recs: Array<Partial<LogRecommendation>>): LogEntry {
  return {
    id: "t",
    savedAt: new Date().toISOString(),
    recommendations: recs.map((r) => ({ outcome: "PENDING", ...r }) as LogRecommendation),
  };
}

describe("getCalibrationSamples — raw-probability invariant", () => {
  it("uses model_probability_raw when present, not the calibrated value", () => {
    const entries = [
      entryWith([
        {
          tier: 1,
          model_probability: 0.58, // calibrated (post-shrink)
          model_probability_raw: 0.66, // raw — what λ must be fit against
          odds: 1.9,
          outcome: "WON",
        },
      ]),
    ];
    const samples = getCalibrationSamples(entries);
    expect(samples).toHaveLength(1);
    expect(samples[0].model_p).toBe(0.66);
  });

  it("falls back to model_probability for legacy entries without raw", () => {
    const entries = [
      entryWith([{ tier: 1, model_probability: 0.6, odds: 2.0, outcome: "LOST" }]),
    ];
    const samples = getCalibrationSamples(entries);
    expect(samples).toHaveLength(1);
    expect(samples[0].model_p).toBe(0.6);
  });

  it("excludes tier 3/4 (parlay p_joint is a different estimator class)", () => {
    const entries = [
      entryWith([
        { tier: 3, model_probability: 0.25, odds: 4.96, outcome: "WON" },
        { tier: 4, model_probability: 0.1, odds: 10, outcome: "LOST" },
        { tier: 2, model_probability_raw: 0.55, model_probability: 0.53, odds: 1.8, outcome: "WON" },
      ]),
    ];
    const samples = getCalibrationSamples(entries);
    expect(samples).toHaveLength(1);
    expect(samples[0].model_p).toBe(0.55);
  });

  it("still excludes PENDING / PUSH / VOID and action bets", () => {
    const entries = [
      entryWith([
        { tier: 1, model_probability_raw: 0.6, odds: 1.9, outcome: "PENDING" },
        { tier: 1, model_probability_raw: 0.6, odds: 1.9, outcome: "PUSH" },
        { tier: 1, model_probability_raw: 0.6, odds: 1.9, outcome: "VOID" },
        { tier: 1, model_probability_raw: 0.6, odds: 1.9, outcome: "WON", action_bet: true },
      ]),
    ];
    expect(getCalibrationSamples(entries)).toHaveLength(0);
  });
});

describe("buildLogEntryFromEnriched carries model_probability_raw", () => {
  it("pushStraight copies bet.model_probability_raw into the log rec", () => {
    const result = {
      match: "A vs B",
      bet_1: {
        active: true,
        market: "Goal Totals",
        selection: "Under 2.5 Goals",
        odds: 1.78,
        model_probability: 0.601, // calibrated
        model_probability_raw: 0.618, // raw
        ev: 0.07,
      },
    } as unknown as AnalysisResult;
    const entry = buildLogEntryFromEnriched(result);
    expect(entry.recommendations).toHaveLength(1);
    expect(entry.recommendations[0].model_probability).toBe(0.601);
    expect(entry.recommendations[0].model_probability_raw).toBe(0.618);
  });
});

describe("λ-recovery regression — fit domain matches application domain", () => {
  it("recovers a low λ from raw overconfident samples (no drift toward 1.0)", () => {
    // Ground truth: true win prob = market prob (model edge is pure
    // overconfidence). Raw model probs inflated +0.12 above market. The best
    // λ against RAW samples is near 0 (trust market). If samples had been
    // pre-shrunk (the old bug), the fit would sit much higher.
    const samples = [];
    for (let i = 0; i < 200; i++) {
      const odds = 1.8 + (i % 5) * 0.2; // 1.8..2.6
      const marketP = 1 / odds;
      const rawModelP = Math.min(0.95, marketP + 0.12);
      samples.push({
        model_p: rawModelP,
        decimal_odds: odds,
        won: i % Math.round(1 / marketP) === 0, // ≈ market-rate wins
      });
    }
    const lambda = fitLambda(samples);
    expect(lambda).toBeLessThanOrEqual(0.3);
    expect(lambda).toBeLessThan(DEFAULT_LAMBDA);
  });
});

describe("PUSH/VOID settlement semantics", () => {
  it("computeEvRealised: PUSH and VOID realise 0", () => {
    expect(computeEvRealised({ outcome: "PUSH" } as LogRecommendation)).toBe(0);
    expect(computeEvRealised({ outcome: "VOID" } as LogRecommendation)).toBe(0);
  });

  it("cycleOutcome path includes PUSH: PENDING→WON→LOST→PUSH→PENDING", () => {
    expect(cycleOutcome("PENDING")).toBe("WON");
    expect(cycleOutcome("WON")).toBe("LOST");
    expect(cycleOutcome("LOST")).toBe("PUSH");
    expect(cycleOutcome("PUSH")).toBe("PENDING");
  });

  it("computeSummary: PUSH returns the stake (neutral), excluded from win rate", () => {
    const entries = [
      entryWith([
        { tier: 1, stake: "$10", odds: 2.0, outcome: "WON" },
        { tier: 1, stake: "$10", odds: 2.0, outcome: "PUSH" },
        { tier: 1, stake: "$10", odds: 2.0, outcome: "LOST" },
      ]),
    ];
    const s = computeSummary(entries);
    // WON returns 20, PUSH returns its 10 back, LOST returns 0.
    expect(s.totalReturned).toBe(30);
    expect(s.wonCount).toBe(1);
    expect(s.lostCount).toBe(1);
    expect(s.winRate).toBe(50); // PUSH not in the denominator
    expect(s.pendingCount).toBe(0); // PUSH is settled, not pending
  });
});
