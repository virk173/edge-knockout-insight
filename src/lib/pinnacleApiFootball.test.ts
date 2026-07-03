import { describe, it, expect } from "vitest";
import {
  buildPinnacleSummaryFromApiFootball,
  buildStakeGapCheck,
  extractStakeMarkets,
  PINNACLE_BOOKMAKER_ID,
} from "./analyse";

// C9B was repointed from TheStatsAPI (which for WC2026 carries ONLY Bet365, no
// Pinnacle, no opening field) to API-Football's own /odds feed filtered to
// bookmaker=4 (Pinnacle). These tests lock in the corrected behaviour.
//
// SHAPE NOTE: afGet unwraps the API-Football envelope to `json.response`, so
// buildPinnacleSummaryFromApiFootball receives the response array directly:
//   [ { fixture, bookmakers: [ { id, name, bets: [ { name, values } ] } ] } ]

const pinnacleResponse = [
  {
    fixture: { id: 1565179 },
    bookmakers: [
      {
        id: 4,
        name: "Pinnacle",
        bets: [
          {
            name: "Match Winner",
            values: [
              { value: "Home", odd: "1.80" },
              { value: "Draw", odd: "3.60" },
              { value: "Away", odd: "4.50" },
            ],
          },
          {
            name: "Goals Over/Under",
            values: [
              { value: "Over 2.5", odd: "1.95" },
              { value: "Under 2.5", odd: "1.85" },
            ],
          },
          {
            name: "Asian Handicap",
            values: [
              { value: "Home -0.5", odd: "1.90" },
              { value: "Away +0.5", odd: "1.90" },
            ],
          },
        ],
      },
    ],
  },
];

// A response where the returned bookmaker is NOT Pinnacle (defensive: should be
// treated as empty by the caller, never as a Pinnacle fallback).
const nonPinnacleResponse = [
  {
    fixture: { id: 1565179 },
    bookmakers: [
      {
        id: 8,
        name: "Bet365",
        bets: [
          {
            name: "Match Winner",
            values: [
              { value: "Home", odd: "1.75" },
              { value: "Draw", odd: "3.70" },
              { value: "Away", odd: "4.80" },
            ],
          },
        ],
      },
    ],
  },
];

describe("C9B — Pinnacle price levels from API-Football bookmaker=4", () => {
  it("bookmaker=4 present → is_pinnacle true, prices extracted, opening stays null", () => {
    const summary = buildPinnacleSummaryFromApiFootball(pinnacleResponse);
    expect(summary).not.toBeNull();
    expect(summary!.is_pinnacle).toBe(true);
    expect(summary!.bookmaker.toLowerCase()).toContain("pinnacle");

    const oneX2 = summary!.markets.find(
      (m) => m.market === "1X2 Full Time Result",
    );
    expect(oneX2).toBeDefined();
    const home = oneX2!.outcomes.find((o) => o.name === "Home");
    expect(home!.current).toBe(1.8);

    // CRITICAL: opening is NEVER defaulted to last_seen / current — it must stay
    // null so a fake 0%-movement reading is not produced. movement stays null.
    for (const m of summary!.markets) {
      for (const o of m.outcomes) {
        expect(o.opening).toBeNull();
        expect(o.movement_pct).toBeNull();
        expect(o.signal).toBe("UNKNOWN");
      }
    }

    // overround computable from the 1X2 current prices.
    const overround = oneX2!.outcomes
      .filter((o) => ["Home", "Draw", "Away"].includes(o.name))
      .reduce((acc, o) => acc + (o.current ? 1 / o.current : 0), 0);
    expect(overround).toBeGreaterThan(1);
  });

  it("bookmaker=4 absent (empty response) → null (caller records EMPTY, pinnacle_available false)", () => {
    expect(buildPinnacleSummaryFromApiFootball([])).toBeNull();
    expect(buildPinnacleSummaryFromApiFootball(null)).toBeNull();
    expect(buildPinnacleSummaryFromApiFootball({ response: [] })).toBeNull();
  });

  it("non-Pinnacle bookmaker returned → is_pinnacle false (no retail fallback masquerades as Pinnacle)", () => {
    const summary = buildPinnacleSummaryFromApiFootball(nonPinnacleResponse);
    // A summary may parse, but is_pinnacle must be false so the caller records
    // EMPTY rather than treating Bet365 as a Pinnacle slot.
    expect(summary?.is_pinnacle ?? false).toBe(false);
  });

  it("no code path produces a TheStatsAPI-shaped C9B result (API-Football parser ignores nested {data:{bookmakers}})", () => {
    // The TheStatsAPI odds shape { data: { bookmakers: [{ bookmaker, markets:{...} }] } }
    // has no `bets` array, so the API-Football parser extracts nothing from it.
    const statsApiShape = {
      data: {
        bookmakers: [
          {
            bookmaker: "Bet365",
            markets: {
              match_odds: {
                home: { opening: null, last_seen: "1.14" },
                draw: { opening: null, last_seen: "7.0" },
                away: { opening: null, last_seen: "19.0" },
              },
            },
          },
        ],
      },
    };
    // is_pinnacle false and no markets → null / non-pinnacle, never a usable C9B.
    const summary = buildPinnacleSummaryFromApiFootball(statsApiShape);
    expect(summary?.is_pinnacle ?? false).toBe(false);
  });

  it("PINNACLE_BOOKMAKER_ID is 4", () => {
    expect(PINNACLE_BOOKMAKER_ID).toBe(4);
  });
});

describe("C9B — Pinnacle gap check vs C9A retail price", () => {
  // C9A retail (API-Football, e.g. 10Bet/Bet365) 1X2 payload — same shape C9A
  // extracts from.
  const c9aRetailOdds = [
    {
      bookmakers: [
        {
          name: "10Bet",
          bets: [
            {
              name: "Match Winner",
              values: [
                { value: "Home", odd: "1.90" }, // retail better than Pinnacle 1.80
                { value: "Draw", odd: "3.40" }, // retail worse than Pinnacle 3.60
                { value: "Away", odd: "4.50" }, // equal
              ],
            },
          ],
        },
      ],
    },
  ];

  it("produces a real gap_pct + verdict per outcome (single snapshot each side, no history needed)", () => {
    const summary = buildPinnacleSummaryFromApiFootball(pinnacleResponse);
    const gap = buildStakeGapCheck(c9aRetailOdds, summary!.markets);
    expect(gap.length).toBe(3);

    const home = gap.find((g) => g.outcome === "Home")!;
    expect(home.stake).toBe(1.9);
    expect(home.pinnacle).toBe(1.8);
    // gap_pct = (1.90 / 1.80 - 1) * 100 = 5.6 (rounded to 0.1)
    expect(home.gap_pct).toBeCloseTo(5.6, 1);
    expect(home.verdict).toBe("STAKE OFFERS VALUE");

    const draw = gap.find((g) => g.outcome === "Draw")!;
    // gap_pct = (3.40 / 3.60 - 1) * 100 = -5.6
    expect(draw.gap_pct).toBeCloseTo(-5.6, 1);
    expect(draw.verdict).toBe("STAKE WORSE");

    const away = gap.find((g) => g.outcome === "Away")!;
    expect(away.gap_pct).toBe(0);
    expect(away.verdict).toBe("EQUAL");
  });
});

describe("C9A pinning (Bet365 primary) is unaffected by the C9B repoint", () => {
  it("extractStakeMarkets still parses the C9A retail 1X2 payload unchanged", () => {
    const c9a = [
      {
        bookmakers: [
          {
            name: "Bet365",
            bets: [
              {
                name: "Match Winner",
                values: [
                  { value: "Home", odd: "1.90" },
                  { value: "Draw", odd: "3.40" },
                  { value: "Away", odd: "4.20" },
                ],
              },
            ],
          },
        ],
      },
    ];
    const parsed = extractStakeMarkets(c9a);
    expect(parsed).not.toBeNull();
    expect(parsed!.bookmaker).toBe("Bet365");
    expect(parsed!.markets["1X2 (Match Winner)"]).toBeDefined();
  });
});
