import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  formatDataForClaude,
  verifyFixture,
  retrySingleCall,
} from "./analyse";
import {
  readCallCache,
  writeCallCache,
  callCacheClass,
  ttlForKey,
} from "./callCache";
import { calculateResults } from "./calculate";

// EDGE-FIX tier 7 — GAP 1 (pipeline tests) + GAP 2 (pinnacle-gap E2E).

// ---------------------------------------------------------------------------
// Minimal localStorage shim so cache/retry paths run under the node test env.
// ---------------------------------------------------------------------------
function installLocalStorage() {
  const store = new Map<string, string>();
  const ls = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  };
  (globalThis as Record<string, unknown>).window = { localStorage: ls };
  return store;
}
function removeLocalStorage() {
  delete (globalThis as Record<string, unknown>).window;
}

// ---------------------------------------------------------------------------
// 7.1 — formatDataForClaude permutations
// ---------------------------------------------------------------------------
describe("formatDataForClaude — status permutations", () => {
  it("renders SUCCESS / EMPTY / FAILED / EXPECTED_EMPTY / missing correctly", () => {
    const out = formatDataForClaude({
      "2A": { key: "2A", label: "", status: "SUCCESS", data: { extracted: { form: "WWWWW" } } },
      "3": { key: "3", label: "", status: "EMPTY", error: "No H2H found." },
      "5": { key: "5", label: "", status: "FAILED", error: "network down" },
      "10": { key: "10", label: "", status: "EXPECTED_EMPTY" },
      // "8" entirely missing.
    } as never);

    expect(out).toContain("[CALL 2A — ");
    expect(out).toContain('"form": "WWWWW"');
    expect(out).toMatch(/\[CALL 3 — .* — EMPTY\]/);
    expect(out).toContain("No H2H found.");
    // FAILED renders as an EMPTY block with the error note — never data.
    expect(out).toMatch(/\[CALL 5 — .* — EMPTY\]/);
    expect(out).toContain("network down");
    expect(out).toContain("EXPECTED EMPTY");
    expect(out).toContain("Round of 32 still in progress");
    // Missing call 8 still renders an explicit EMPTY block.
    expect(out).toMatch(/\[CALL 8 — .* — EMPTY\]/);
    // Every block is closed.
    const opens = (out.match(/\[CALL /g) ?? []).length;
    const closes = (out.match(/\[END CALL /g) ?? []).length;
    expect(opens).toBe(closes);
  });

  it("synthesizes 9A from the combined '9' result (SUCCESS with data, EMPTY without)", () => {
    const stakeOdds = [
      {
        bookmakers: [
          {
            name: "Stake",
            bets: [
              {
                name: "Match Winner",
                values: [
                  { value: "Home", odd: "1.80" },
                  { value: "Draw", odd: "3.60" },
                  { value: "Away", odd: "4.50" },
                ],
              },
            ],
          },
        ],
      },
    ];
    const withOdds = formatDataForClaude({
      "9": { key: "9", label: "", status: "SUCCESS", data: { stakeOdds } },
    } as never);
    expect(withOdds).toMatch(/\[CALL 9A — .* — SUCCESS\]/);
    expect(withOdds).toContain("1X2 (Match Winner)");

    const noOdds = formatDataForClaude({
      "9": { key: "9", label: "", status: "SUCCESS", data: { stakeOdds: [] } },
    } as never);
    expect(noOdds).toMatch(/\[CALL 9A — .* — EMPTY\]/);
  });

  it("C9B block is minified (single-line JSON), other blocks pretty-printed", () => {
    const out = formatDataForClaude({
      "9B": {
        key: "9B",
        label: "",
        status: "SUCCESS",
        data: {
          markets: [
            { market: "1X2 Full Time Result", outcomes: [{ name: "Home", current: 1.8 }] },
          ],
        },
      },
      "5": {
        key: "5",
        label: "",
        status: "SUCCESS",
        data: [{ player: { name: "X", type: "Injury" }, team: { name: "T" } }],
      },
    } as never);
    const block9B = out.match(/\[CALL 9B[\s\S]*?\[END CALL 9B\]/)?.[0] ?? "";
    // Minified: the JSON payload is one line (header line + json line + end line).
    expect(block9B.split("\n").length).toBe(3);
    const block5 = out.match(/\[CALL 5[\s\S]*?\[END CALL 5\]/)?.[0] ?? "";
    expect(block5.split("\n").length).toBeGreaterThan(3);
  });
});

// ---------------------------------------------------------------------------
// 7.2 — C1-mismatch invariant
// ---------------------------------------------------------------------------
describe("C1 fixture-verification invariant", () => {
  it("verifyFixture: mismatch is FAILED-verified=false, unreadable teams are INCONCLUSIVE", () => {
    const m = { id: 1, home: "Mexico", away: "Ecuador" };
    const ok = verifyFixture(m, "Mexico", "Ecuador");
    expect(ok.verified).toBe(true);
    const wrong = verifyFixture(m, "France", "Senegal");
    expect(wrong.verified).toBe(false);
    expect(wrong.reason).toContain("ID mismatch");
    const inconclusive = verifyFixture(m, null, null);
    expect(inconclusive.verified).toBe(false);
    expect(inconclusive.reason).toContain("INCONCLUSIVE");
  });

  it("retrySingleCall: a cached C1 FAILED blocks every AF id-dependent retry without any network call", async () => {
    installLocalStorage();
    try {
      const match = {
        id: 777,
        home: "Mexico",
        away: "Ecuador",
        homeId: 1,
        awayId: 2,
        kickoffUtc: "2026-07-04T00:00:00Z",
        round: "Round of 32",
      } as never;
      writeCallCache(777, "C1", {
        key: "C1",
        label: "Fixture verification",
        status: "FAILED",
        error: "ID mismatch",
      });
      const out = await retrySingleCall(match, "5");
      expect(out["5"]?.status).toBe("BLOCKED");
      expect(out["5"]?.error).toContain("C1 fixture mismatch");
      // "4" blocks all three sub-keys.
      const out4 = await retrySingleCall(match, "4");
      expect(out4["4-1"]?.status).toBe("BLOCKED");
      expect(out4["4-2"]?.status).toBe("BLOCKED");
      expect(out4["4-3"]?.status).toBe("BLOCKED");
    } finally {
      removeLocalStorage();
    }
  });

  it("retrySingleCall 9B collision guard: C9A already on bookmaker 4 → EMPTY, no fetch", async () => {
    const store = installLocalStorage();
    try {
      store.set("stake_bookmaker_id", "4");
      const match = {
        id: 778,
        home: "A",
        away: "B",
        homeId: 1,
        awayId: 2,
        kickoffUtc: "2026-07-04T00:00:00Z",
        round: "Round of 32",
      } as never;
      const out = await retrySingleCall(match, "9B");
      expect(out["9B"]?.status).toBe("EMPTY");
      expect(out["9B"]?.error).toContain("duplicate");
    } finally {
      removeLocalStorage();
    }
  });
});

// ---------------------------------------------------------------------------
// 7.3 — callCache TTL boundaries
// ---------------------------------------------------------------------------
describe("callCache TTL boundaries", () => {
  beforeEach(() => {
    installLocalStorage();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    removeLocalStorage();
  });

  it("odds keys expire after 15 minutes; static keys after 60", () => {
    const now = Date.now();
    writeCallCache(1, "9B", { key: "9B", label: "", status: "SUCCESS", data: 1, fetchedAt: now });
    writeCallCache(1, "3", { key: "3", label: "", status: "SUCCESS", data: 1, fetchedAt: now });

    vi.setSystemTime(now + 14 * 60 * 1000);
    expect(readCallCache(1, "9B")).not.toBeNull();
    vi.setSystemTime(now + 16 * 60 * 1000);
    expect(readCallCache(1, "9B")).toBeNull(); // odds expired
    expect(readCallCache(1, "3")).not.toBeNull(); // static still fresh
    vi.setSystemTime(now + 61 * 60 * 1000);
    expect(readCallCache(1, "3")).toBeNull();
  });

  it("lineups ('6') are never cached — write is a no-op, read always null", () => {
    expect(callCacheClass("6")).toBe("never");
    writeCallCache(1, "6", { key: "6", label: "", status: "SUCCESS", data: 1 });
    expect(readCallCache(1, "6")).toBeNull();
  });

  it("cache keys are match-scoped — no cross-match reads", () => {
    writeCallCache(1, "3", { key: "3", label: "", status: "SUCCESS", data: "match1" });
    expect(readCallCache(2, "3")).toBeNull();
  });

  it("ttlForKey: 9/9B are odds-class, everything else static", () => {
    expect(ttlForKey("9")).toBe(15 * 60 * 1000);
    expect(ttlForKey("9B")).toBe(15 * 60 * 1000);
    expect(ttlForKey("3")).toBe(60 * 60 * 1000);
  });
});

// ---------------------------------------------------------------------------
// 7.4 — GAP 2: pinnacle-gap E2E through calculateResults
// ---------------------------------------------------------------------------
describe("Pinnacle gap E2E through calculateResults", () => {
  const bet = (pinnacle_odds: number | null) => ({
    match: "A vs B",
    bet_1: {
      active: true,
      market: "Goal Totals",
      selection: "Under 2.5 Goals",
      ev_inputs: { model_probability: 0.62, decimal_odds: 1.9 },
      pinnacle_odds,
    },
  });

  it("gap > 5%: raw_ev preserved, ev shaded x0.85, Kelly sized on the SHADED ev", () => {
    // Stake 1.90 vs Pinnacle 1.70 → gap +11.8% → shade.
    const out = calculateResults(bet(1.7), { bankroll: 1000, lambda: 1 }); // λ=1: no shrink, isolate the gap logic
    const b = out.bet_1!;
    // raw EV = 0.62*1.9-1 = 0.178
    expect(b.raw_ev).toBeCloseTo(0.178, 3);
    expect(b.ev).toBeCloseTo(0.178 * 0.85, 3);
    expect(b.ev_confidence).toBe("MEDIUM");
    expect(String(b.pinnacle_check_note)).toContain("better than Pinnacle");
    // Kelly on the shaded EV: 0.1513/(1.9-1) * 0.25 * 1000 = 42.03
    expect(b.kelly_result?.raw_stake).toBeCloseTo((0.178 * 0.85) / 0.9 * 0.25 * 1000, 0);
  });

  it("gap < -3%: EV unchanged, confidence raised to HIGH", () => {
    // Stake 1.90 vs Pinnacle 2.00 → gap -5% → confidence-only.
    const out = calculateResults(bet(2.0), { bankroll: 1000, lambda: 1 });
    const b = out.bet_1!;
    expect(b.ev).toBeCloseTo(0.178, 3);
    expect(b.ev_confidence).toBe("HIGH");
    expect(String(b.pinnacle_check_note)).toContain("worse than Pinnacle");
  });

  it("no Pinnacle reference: EV unchanged, confidence MEDIUM, note says unverified", () => {
    const out = calculateResults(bet(null), { bankroll: 1000, lambda: 1 });
    const b = out.bet_1!;
    expect(b.ev).toBeCloseTo(0.178, 3);
    expect(b.ev_confidence).toBe("MEDIUM");
    expect(String(b.pinnacle_check_note)).toContain("No Pinnacle reference");
  });
});
