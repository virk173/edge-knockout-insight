import { describe, it, expect } from "vitest";
import { clvSelectionLabel } from "./analyse";
import { matchClosingPrice, computeClv, type ClosingCapture } from "./clv";

// EDGE-FIX tier 3 — capture-time selection normalization. Raw feeds label 1X2
// outcomes "Home"/"Away" and AH lines "Home -1.5"; Claude's bet selections are
// team-name based ("France Win", "USA -1"). Without normalization those bets
// silently never received a CLV value (matchClosingPrice returned null).

describe("clvSelectionLabel", () => {
  it("rewrites bare Home/Away/1/2 to team names, keeps Draw", () => {
    expect(clvSelectionLabel("Home", "France", "Senegal")).toBe("France");
    expect(clvSelectionLabel("Away", "France", "Senegal")).toBe("Senegal");
    expect(clvSelectionLabel("1", "France", "Senegal")).toBe("France");
    expect(clvSelectionLabel("2", "France", "Senegal")).toBe("Senegal");
    expect(clvSelectionLabel("Draw", "France", "Senegal")).toBe("Draw");
    expect(clvSelectionLabel("X", "France", "Senegal")).toBe("Draw");
  });

  it("rewrites sided AH lines to team-name lines", () => {
    expect(clvSelectionLabel("Home -1.5", "USA", "Bosnia")).toBe("USA -1.5");
    expect(clvSelectionLabel("Away +0.5", "USA", "Bosnia")).toBe("Bosnia +0.5");
    expect(clvSelectionLabel("Home -1", "USA", "Bosnia")).toBe("USA -1");
  });

  it("passes through line-based selections unchanged", () => {
    expect(clvSelectionLabel("Over 2.5", "France", "Senegal")).toBe("Over 2.5");
    expect(clvSelectionLabel("Under 9.5", "France", "Senegal")).toBe("Under 9.5");
    expect(clvSelectionLabel("Yes", "France", "Senegal")).toBe("Yes");
  });
});

describe("capture → matchClosingPrice round trip with Claude-style selections", () => {
  // Shaped exactly like captureClosingOdds writes post-fix: Pinnacle market
  // labels, selections already normalized to team names.
  const home = "France";
  const away = "Senegal";
  const capture: ClosingCapture = {
    matchId: 999,
    capturedAt: Date.now(),
    minutesBeforeKickoff: 10,
    source: "PINNACLE",
    prices: {
      "1X2 Full Time Result": [
        { selection: clvSelectionLabel("Home", home, away), odds: 1.65 },
        { selection: clvSelectionLabel("Draw", home, away), odds: 4.05 },
        { selection: clvSelectionLabel("Away", home, away), odds: 5.9 },
      ],
      "Over/Under Goals": [
        { selection: clvSelectionLabel("Over 2.5", home, away), odds: 2.1 },
        { selection: clvSelectionLabel("Under 2.5", home, away), odds: 1.72 },
      ],
      "Asian Handicap": [
        { selection: clvSelectionLabel("Home -1", home, away), odds: 2.05 },
        { selection: clvSelectionLabel("Away +1", home, away), odds: 1.72 },
      ],
    },
  };

  it('1X2: Claude selection "France Win" now matches the close', () => {
    const close = matchClosingPrice(capture, "Moneyline (3-way)", "France Win");
    expect(close).not.toBeNull();
    expect(close!.odds).toBe(1.65);
    // Bet placed at 1.72 vs 1.65 close → positive CLV.
    expect(computeClv(1.72, close!.odds)).toBeCloseTo(4.24, 1);
  });

  it('AH: Claude selection "France -1" now matches the close', () => {
    const close = matchClosingPrice(capture, "Asian Handicap", "France -1");
    expect(close).not.toBeNull();
    expect(close!.odds).toBe(2.05);
  });

  it('Goals: "Under 2.5 Goals" keeps matching (regression)', () => {
    const close = matchClosingPrice(capture, "Goal Totals (Over/Under)", "Under 2.5 Goals");
    expect(close).not.toBeNull();
    expect(close!.odds).toBe(1.72);
  });

  it("still never guesses: unknown selection returns null", () => {
    expect(matchClosingPrice(capture, "Moneyline (3-way)", "Brazil Win")).toBeNull();
  });

  it("multi-line AH: exact match wins over substring (France -1 never grabs the -1.5 price)", () => {
    const multiLine: ClosingCapture = {
      ...capture,
      prices: {
        "Asian Handicap": [
          { selection: "France -1.5", odds: 2.4 }, // substring trap listed FIRST
          { selection: "France -1", odds: 2.05 },
        ],
      },
    };
    const close = matchClosingPrice(multiLine, "Asian Handicap", "France -1");
    expect(close!.odds).toBe(2.05);
    const close15 = matchClosingPrice(multiLine, "Asian Handicap", "France -1.5");
    expect(close15!.odds).toBe(2.4);
  });
});
