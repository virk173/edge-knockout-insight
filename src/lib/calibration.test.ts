import { describe, it, expect } from "vitest";
import {
  calibrateProbability,
  fitLambda,
  DEFAULT_LAMBDA,
  type CalibrationSample,
} from "@/lib/calibration";

describe("calibrateProbability", () => {
  it("shrinks the model toward the market by λ", () => {
    // marketP = 1/1.78 = 0.5618; 0.5618 + 0.7*(0.65-0.5618) = 0.6235
    expect(calibrateProbability(0.65, 1.78, 0.7)).toBeCloseTo(0.6235, 3);
    // spec's rounded target
    expect(calibrateProbability(0.65, 1.78, 0.7)).toBeCloseTo(0.6247, 2);
  });

  it("λ=1 returns modelP exactly", () => {
    expect(calibrateProbability(0.65, 1.78, 1)).toBeCloseTo(0.65, 10);
  });

  it("λ=0 returns 1/odds exactly", () => {
    expect(calibrateProbability(0.65, 1.78, 0)).toBeCloseTo(1 / 1.78, 10);
  });
});

describe("fitLambda", () => {
  it("stays at DEFAULT_LAMBDA below MIN_N_TO_FIT", () => {
    const few: CalibrationSample[] = [
      { model_p: 0.6, decimal_odds: 2.0, won: true },
      { model_p: 0.6, decimal_odds: 2.0, won: false },
    ];
    expect(fitLambda(few)).toBe(DEFAULT_LAMBDA);
  });

  it("converges to λ ≤ 0.3 on overconfident data (model inflated +0.10)", () => {
    // odds 2.0 → market p = 0.5 (the true rate). model p inflated to 0.6.
    // Realized win rate = 0.5 → optimum shrinks fully toward market.
    const samples: CalibrationSample[] = [];
    for (let i = 0; i < 20; i++) {
      samples.push({ model_p: 0.6, decimal_odds: 2.0, won: i < 10 });
    }
    expect(fitLambda(samples)).toBeLessThanOrEqual(0.3);
  });

  it("converges to λ ≥ 0.8 on perfect data (won rate == model p)", () => {
    // odds 2.5 → market p = 0.4, model p = 0.6, realized win rate = 0.6.
    // Optimum keeps the model (calP = 0.6) → λ = 1.
    const samples: CalibrationSample[] = [];
    for (let i = 0; i < 20; i++) {
      samples.push({ model_p: 0.6, decimal_odds: 2.5, won: i < 12 });
    }
    expect(fitLambda(samples)).toBeGreaterThanOrEqual(0.8);
  });
});
