import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { clvSelectionLabel, captureClosingOdds } from "./analyse";
import { matchClosingPrice, computeClv, type ClosingCapture } from "./clv";
import type { AnalysedMatch } from "./fixtures";

// apiFetch is mocked so captureClosingOdds can run under the node test env
// with a controlled odds payload (no network). Only the collision-guard tests
// below exercise it; the pure-function tests above never call apiFetch.
const { apiFetchSpy } = vi.hoisted(() => ({
  apiFetchSpy: vi.fn(),
}));
vi.mock("./api-proxy.functions", () => ({ apiFetch: apiFetchSpy }));

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

// ─────────────────────────────────────────────────────────────
// AUDIT FIX — captureClosingOdds C9A=Pinnacle collision guard.
// The main-pipeline C9B block already guarded against stake_bookmaker_id
// resolving to Pinnacle (id 4); the closing capture didn't, so it would fetch
// the same book twice and silently lose the retail reference. The capture now
// skips the retail pass when the stored "Stake" id IS Pinnacle.
// ─────────────────────────────────────────────────────────────
describe("captureClosingOdds — Pinnacle collision guard", () => {
  const pinnacleOdds = [
    {
      fixture: { id: 777 },
      bookmakers: [
        {
          id: 4,
          name: "Pinnacle",
          bets: [
            {
              name: "Match Winner",
              values: [
                { value: "Home", odd: "1.65" },
                { value: "Draw", odd: "4.05" },
                { value: "Away", odd: "5.90" },
              ],
            },
          ],
        },
      ],
    },
  ];

  const match = {
    id: 777,
    home: "France",
    away: "Senegal",
    kickoffUtc: new Date(Date.now() + 10 * 60000).toISOString(),
  } as unknown as AnalysedMatch;

  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    apiFetchSpy.mockReset();
    apiFetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: { response: pinnacleOdds },
    });
    (globalThis as Record<string, unknown>).window = {
      localStorage: {
        getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
        setItem: (k: string, v: string) => void store.set(k, String(v)),
        removeItem: (k: string) => void store.delete(k),
        key: (i: number) => [...store.keys()][i] ?? null,
        get length() {
          return store.size;
        },
      },
    };
  });
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).window;
  });

  it("stake_bookmaker_id=4 → retail pass skipped, single bookmaker=4 fetch, source PINNACLE", async () => {
    store.set("stake_bookmaker_id", "4");
    const capture = await captureClosingOdds(match);
    const urls = apiFetchSpy.mock.calls.map(
      (c) => (c[0] as { data: { url: string } }).data.url,
    );
    const oddsCalls = urls.filter((u) => u.includes("/odds?fixture="));
    expect(oddsCalls).toHaveLength(1);
    expect(oddsCalls[0]).toContain("bookmaker=4");
    expect(capture).not.toBeNull();
    expect(capture!.source).toBe("PINNACLE");
    expect(capture!.prices["1X2 Full Time Result"]).toBeDefined();
  });

  it("distinct stake id → both passes run (retail + Pinnacle), two odds fetches", async () => {
    store.set("stake_bookmaker_id", "22");
    await captureClosingOdds(match);
    const urls = apiFetchSpy.mock.calls.map(
      (c) => (c[0] as { data: { url: string } }).data.url,
    );
    const oddsCalls = urls.filter((u) => u.includes("/odds?fixture="));
    expect(oddsCalls).toHaveLength(2);
    expect(oddsCalls[0]).toContain("bookmaker=22");
    expect(oddsCalls[1]).toContain("bookmaker=4");
  });
});
