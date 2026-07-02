import { describe, it, expect } from "vitest";
import { normalizeAnalysisResult } from "@/lib/normalizeAnalysisResult";

// The normalizer is the single boundary that lets the display components read
// containers without optional chaining. These tests lock in the two guarantees
// the UI depends on: (1) parsing NEVER throws, and (2) the guaranteed
// containers/arrays always exist, while every other (computed) field passes
// through untouched.

describe("normalizeAnalysisResult", () => {
  const assertGuaranteed = (r: ReturnType<typeof normalizeAnalysisResult>) => {
    expect(r.confidence_scores).toBeTypeOf("object");
    expect(Array.isArray(r.confidence_scores.adjustments)).toBe(true);
    expect(r.ensemble_check).toBeTypeOf("object");
    expect(r.player_intelligence).toBeTypeOf("object");
    expect(Array.isArray(r.player_intelligence.absences)).toBe(true);
    expect(r.bet_1).toBeTypeOf("object");
    expect(r.bet_2).toBeTypeOf("object");
    expect(Array.isArray(r.bet_3.legs)).toBe(true);
    expect(Array.isArray(r.bet_4.legs)).toBe(true);
    expect(Array.isArray(r.markets_evaluated)).toBe(true);
    expect(Array.isArray(r.markets_rejected)).toBe(true);
  };

  it("never throws on non-object inputs and still returns guaranteed containers", () => {
    for (const bad of [null, undefined, "nope", 42, [], true]) {
      assertGuaranteed(normalizeAnalysisResult(bad as unknown));
    }
  });

  it("degrades wrong-typed containers to safe defaults", () => {
    const r = normalizeAnalysisResult({
      confidence_scores: "broken",
      ensemble_check: 5,
      bet_3: 9,
      markets_evaluated: { not: "an array" },
    });
    assertGuaranteed(r);
    expect(r.confidence_scores.adjustments).toEqual([]);
    expect(r.bet_3.legs).toEqual([]);
    expect(r.markets_evaluated).toEqual([]);
  });

  it("preserves computed passthrough fields", () => {
    const r = normalizeAnalysisResult({
      match: "A vs B",
      bet_1: { ev: 0.1, kelly_result: { recommended_stake: 12 } },
      log_entry: { id: 1 },
    }) as unknown as {
      match: string;
      bet_1: { ev: number; kelly_result: { recommended_stake: number } };
      log_entry: { id: number };
    };
    expect(r.match).toBe("A vs B");
    expect(r.bet_1.ev).toBe(0.1);
    expect(r.bet_1.kelly_result.recommended_stake).toBe(12);
    expect(r.log_entry.id).toBe(1);
  });

  it("keeps valid arrays intact", () => {
    const r = normalizeAnalysisResult({
      markets_evaluated: ["1X2", "BTTS"],
      bet_3: { legs: [{ market: "x" }] },
    });
    expect(r.markets_evaluated).toEqual(["1X2", "BTTS"]);
    expect(r.bet_3.legs.length).toBe(1);
  });
});
