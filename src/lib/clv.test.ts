import { describe, it, expect } from "vitest";
import { computeClv, matchClosingPrice, type ClosingCapture } from "@/lib/clv";

describe("computeClv", () => {
  it("positive when bet price beats the close", () => {
    // 2.10 vs 2.00 close → +5%
    expect(computeClv(2.1, 2.0)).toBe(5);
  });

  it("negative when the close beats our price", () => {
    expect(computeClv(1.9, 2.0)).toBe(-5);
  });

  it("rounds to 2dp", () => {
    // 1.78 / 1.74 - 1 = 0.022988... → 2.3%
    expect(computeClv(1.78, 1.74)).toBe(2.3);
  });

  it("returns NaN for invalid closing odds", () => {
    expect(Number.isNaN(computeClv(2.0, 0))).toBe(true);
  });
});

describe("matchClosingPrice", () => {
  const capture: ClosingCapture = {
    matchId: 1,
    capturedAt: Date.now(),
    minutesBeforeKickoff: 5,
    source: "PINNACLE",
    prices: {
      "Match Winner": [
        { selection: "USA", odds: 1.74 },
        { selection: "Draw", odds: 3.5 },
        { selection: "Bosnia", odds: 5.2 },
      ],
      "Goal Totals (Over/Under)": [
        { selection: "Over 2.5", odds: 1.95 },
        { selection: "Under 2.5", odds: 1.88 },
      ],
    },
  };

  it("resolves via resolveMarketType on both sides (1X2 → Match Winner)", () => {
    const r = matchClosingPrice(capture, "1X2", "USA");
    expect(r?.odds).toBe(1.74);
    expect(r?.source).toBe("PINNACLE");
  });

  it("case-insensitive selection substring match, both directions", () => {
    expect(matchClosingPrice(capture, "Match Winner", "usa")?.odds).toBe(1.74);
    expect(
      matchClosingPrice(capture, "Total Goals Over/Under 2.5", "Over 2.5")?.odds,
    ).toBe(1.95);
  });

  it("returns null when unmatched — never guesses", () => {
    expect(matchClosingPrice(capture, "Match Winner", "France")).toBeNull();
    expect(matchClosingPrice(capture, "Corners", "Over 9.5")).toBeNull();
    expect(matchClosingPrice(null, "1X2", "USA")).toBeNull();
  });
});
