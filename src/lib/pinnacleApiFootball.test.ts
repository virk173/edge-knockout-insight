import { describe, it, expect } from "vitest";
import {
  buildPinnacleSummaryFromApiFootball,
  buildStakeGapCheck,
  extractStakeMarkets,
  formatDataForClaude,
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

    const home = gap.find((g) => g.market === "1X2" && g.line === "Home")!;
    expect(home.stake_odds).toBe(1.9);
    expect(home.pinnacle_odds).toBe(1.8);
    // gap_pct = (1.90 / 1.80 - 1) * 100 = 5.6 (rounded to 0.1)
    expect(home.gap_pct).toBeCloseTo(5.6, 1);
    expect(home.verdict).toBe("STAKE OFFERS VALUE vs PINNACLE");

    const draw = gap.find((g) => g.market === "1X2" && g.line === "Draw")!;
    // gap_pct = (3.40 / 3.60 - 1) * 100 = -5.6
    expect(draw.gap_pct).toBeCloseTo(-5.6, 1);
    expect(draw.verdict).toBe("STAKE WORSE THAN PINNACLE");

    const away = gap.find((g) => g.market === "1X2" && g.line === "Away")!;
    expect(away.gap_pct).toBe(0);
    expect(away.verdict).toBe("EQUAL");
  });
});

describe("C9B token bloat fix — line caps on Over/Under Goals and Corners", () => {
  // Realistic 19-bet-block bookmaker=4 feed (mirrors the diagnosed prompt-size
  // issue): many O/U goal lines and many corner lines, plus an uncapped Asian
  // Handicap (left uncapped intentionally, same as C9A).
  const richPinnacleResponse = [
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
              name: "Both Teams Score",
              values: [
                { value: "Yes", odd: "1.75" },
                { value: "No", odd: "2.00" },
              ],
            },
            {
              name: "Goals Over/Under",
              values: [
                { value: "Over 0.5", odd: "1.05" },
                { value: "Under 0.5", odd: "9.00" },
                { value: "Over 1.5", odd: "1.25" },
                { value: "Under 1.5", odd: "3.75" },
                { value: "Over 2.5", odd: "1.95" },
                { value: "Under 2.5", odd: "1.85" },
                { value: "Over 3.5", odd: "3.40" },
                { value: "Under 3.5", odd: "1.28" },
                { value: "Over 4.5", odd: "6.50" },
                { value: "Under 4.5", odd: "1.08" },
                { value: "Over 5.5", odd: "12.00" },
                { value: "Under 5.5", odd: "1.02" },
              ],
            },
            {
              name: "Total Corners",
              values: [
                { value: "Over 7.5", odd: "1.90" },
                { value: "Under 7.5", odd: "1.85" },
                { value: "Over 8.5", odd: "2.10" },
                { value: "Under 8.5", odd: "1.65" },
                { value: "Over 9.5", odd: "2.40" },
                { value: "Under 9.5", odd: "1.50" },
                { value: "Over 10.5", odd: "2.90" },
                { value: "Under 10.5", odd: "1.35" },
              ],
            },
            {
              name: "Asian Handicap",
              values: [
                { value: "Home -2.5", odd: "3.20" },
                { value: "Away +2.5", odd: "1.32" },
                { value: "Home -2.0", odd: "2.85" },
                { value: "Away +2.0", odd: "1.42" },
                { value: "Home -1.5", odd: "2.40" },
                { value: "Away +1.5", odd: "1.55" },
                { value: "Home -1.0", odd: "2.05" },
                { value: "Away +1.0", odd: "1.72" },
                { value: "Home -0.5", odd: "1.90" },
                { value: "Away +0.5", odd: "1.90" },
                { value: "Home 0.0", odd: "1.75" },
                { value: "Away 0.0", odd: "2.05" },
                { value: "Home +0.5", odd: "1.45" },
                { value: "Away -0.5", odd: "2.65" },
                { value: "Home +1.0", odd: "1.30" },
                { value: "Away -1.0", odd: "3.30" },
              ],
            },
          ],
        },
      ],
    },
  ];

  it("Over/Under Goals keeps only the 1.5/2.5/3.5 lines (OPT 1 — 6 outcomes), drops 0.5/4.5/5.5", () => {
    const summary = buildPinnacleSummaryFromApiFootball(richPinnacleResponse);
    const ou = summary!.markets.find((m) => m.market === "Over/Under Goals");
    expect(ou).toBeDefined();
    expect(ou!.outcomes.map((o) => o.name)).toEqual([
      "Over 1.5",
      "Under 1.5",
      "Over 2.5",
      "Under 2.5",
      "Over 3.5",
      "Under 3.5",
    ]);
  });

  it("Corners keeps only 8.5/9.5/10.5 (6 outcomes)", () => {
    const summary = buildPinnacleSummaryFromApiFootball(richPinnacleResponse);
    const corners = summary!.markets.find((m) => m.market === "Corners");
    expect(corners).toBeDefined();
    expect(corners!.outcomes.map((o) => o.name)).toEqual([
      "Over 8.5",
      "Under 8.5",
      "Over 9.5",
      "Under 9.5",
      "Over 10.5",
      "Under 10.5",
    ]);
  });

  it("Asian Handicap now capped to -1.5..+1.5 (OPT 2): 12 of 16 outcomes survive, ±2/±2.5 dropped", () => {
    const summary = buildPinnacleSummaryFromApiFootball(richPinnacleResponse);
    const ah = summary!.markets.find((m) => m.market === "Asian Handicap");
    expect(ah!.outcomes.length).toBe(12);
    expect(ah!.outcomes.some((o) => o.name.includes("2.5"))).toBe(false);
    expect(ah!.outcomes.some((o) => o.name.includes("2.0"))).toBe(false);
    expect(ah!.outcomes.some((o) => o.name.includes("1.5"))).toBe(true);
  });

  it("total outcomes across all markets after OPT 1 + OPT 2: O/U widened to 6, Corners 6, AH capped to 12", () => {
    const summary = buildPinnacleSummaryFromApiFootball(richPinnacleResponse);
    const totalOutcomes = summary!.markets.reduce((a, m) => a + m.outcomes.length, 0);
    // 1X2 (3) + BTTS (2) + O/U (6, OPT 1) + Corners (6) + AH (12, OPT 2) = 29.
    expect(totalOutcomes).toBe(29);

    const callResults: any = {
      "9B": {
        status: "SUCCESS",
        data: {
          matchId: 1565179,
          bookmaker: summary!.bookmaker,
          is_pinnacle: summary!.is_pinnacle,
          source: "API-Football bookmaker=4",
          markets: summary!.markets,
          gap_check: [],
          note: "note",
        },
      },
    };
    const full = formatDataForClaude(callResults);
    const block = full.match(/\[CALL 9B[\s\S]*?\[END CALL 9B\]/)?.[0] ?? "";
    const estTokens = Math.round(block.length / 4);
    // Target: ≤700 tokens after OPT 1 + OPT 2 combined (AH cap + outcome-shape
    // trim to {name, current} bring this well under the old ~1,896 baseline).
    expect(estTokens).toBeLessThanOrEqual(700);
  });

  it("is_pinnacle still resolves true for a genuine bookmaker=4 response after filtering", () => {
    const summary = buildPinnacleSummaryFromApiFootball(richPinnacleResponse);
    expect(summary!.is_pinnacle).toBe(true);
  });

  it("gap check still produces a real number against the filtered 1X2 market", () => {
    const summary = buildPinnacleSummaryFromApiFootball(richPinnacleResponse);
    const c9aRetail = [
      {
        bookmakers: [
          {
            name: "10Bet",
            bets: [
              {
                name: "Match Winner",
                values: [
                  { value: "Home", odd: "1.90" },
                  { value: "Draw", odd: "3.40" },
                  { value: "Away", odd: "4.50" },
                ],
              },
            ],
          },
        ],
      },
    ];
    const gap = buildStakeGapCheck(c9aRetail, summary!.markets);
    const home = gap.find((g) => g.market === "1X2" && g.line === "Home")!;
    expect(home.gap_pct).toBeCloseTo(5.6, 1);
  });
});

describe("C9B — gap check widened to Over/Under Goals, BTTS, Corners, Asian Handicap", () => {
  const pinnacleMulti = [
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
              name: "Both Teams Score",
              values: [
                { value: "Yes", odd: "1.75" },
                { value: "No", odd: "2.00" },
              ],
            },
            {
              name: "Total Corners",
              values: [
                { value: "Over 9.5", odd: "2.40" },
                { value: "Under 9.5", odd: "1.50" },
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

  // Retail side has ALL four new markets, matching value strings exactly.
  const retailMulti = [
    {
      bookmakers: [
        {
          name: "10Bet",
          bets: [
            {
              name: "Match Winner",
              values: [
                { value: "Home", odd: "1.90" },
                { value: "Draw", odd: "3.40" },
                { value: "Away", odd: "4.50" },
              ],
            },
            {
              name: "Goals Over/Under",
              values: [
                { value: "Over 2.5", odd: "2.00" },
                { value: "Under 2.5", odd: "1.75" },
              ],
            },
            {
              name: "Both Teams To Score",
              values: [
                { value: "Yes", odd: "1.80" },
                { value: "No", odd: "2.10" },
              ],
            },
            {
              name: "Corners Over/Under",
              values: [
                { value: "Over 9.5", odd: "2.50" },
                { value: "Under 9.5", odd: "1.45" },
              ],
            },
            {
              name: "Asian Handicap",
              values: [
                { value: "Home -0.5", odd: "1.95" },
                { value: "Away +0.5", odd: "1.85" },
              ],
            },
          ],
        },
      ],
    },
  ];

  it("Over/Under Goals: both sides have Over 2.5 -> gap_check includes it with correct gap_pct", () => {
    const summary = buildPinnacleSummaryFromApiFootball(pinnacleMulti);
    const gap = buildStakeGapCheck(retailMulti, summary!.markets);
    const over25 = gap.find((g) => g.market === "Over/Under Goals" && g.line === "Over 2.5")!;
    expect(over25).toBeDefined();
    expect(over25.stake_odds).toBe(2.0);
    expect(over25.pinnacle_odds).toBe(1.95);
    // (2.00/1.95 - 1) * 100 = 2.5641... -> 2.6
    expect(over25.gap_pct).toBeCloseTo(2.6, 1);
    expect(over25.verdict).toBe("STAKE OFFERS VALUE vs PINNACLE");

    const under25 = gap.find((g) => g.market === "Over/Under Goals" && g.line === "Under 2.5")!;
    // (1.75/1.85 - 1) * 100 = -5.405... -> -5.4
    expect(under25.gap_pct).toBeCloseTo(-5.4, 1);
    expect(under25.verdict).toBe("STAKE WORSE THAN PINNACLE");
  });

  it("Over/Under Goals: Over 2.5 present in Pinnacle but absent from retail -> no entry produced (silent skip, no fabrication)", () => {
    const summary = buildPinnacleSummaryFromApiFootball(pinnacleMulti);
    const retailNoOU = [
      {
        bookmakers: [
          {
            name: "10Bet",
            bets: [
              {
                name: "Match Winner",
                values: [
                  { value: "Home", odd: "1.90" },
                  { value: "Draw", odd: "3.40" },
                  { value: "Away", odd: "4.50" },
                ],
              },
            ],
          },
        ],
      },
    ];
    const gap = buildStakeGapCheck(retailNoOU, summary!.markets);
    expect(gap.find((g) => g.market === "Over/Under Goals")).toBeUndefined();
    // 1X2 entries still produced normally.
    expect(gap.filter((g) => g.market === "1X2").length).toBe(3);
  });

  it("BTTS: Yes present on both sides -> gap_check includes a BTTS entry", () => {
    const summary = buildPinnacleSummaryFromApiFootball(pinnacleMulti);
    const gap = buildStakeGapCheck(retailMulti, summary!.markets);
    const yes = gap.find((g) => g.market === "BTTS" && g.line === "Yes")!;
    expect(yes).toBeDefined();
    expect(yes.stake_odds).toBe(1.8);
    expect(yes.pinnacle_odds).toBe(1.75);
    // (1.80/1.75 - 1) * 100 = 2.857... -> 2.9
    expect(yes.gap_pct).toBeCloseTo(2.9, 1);
  });

  it("Corners: Over 9.5 / Under 9.5 present on both sides -> gap_check includes Corners entries", () => {
    const summary = buildPinnacleSummaryFromApiFootball(pinnacleMulti);
    const gap = buildStakeGapCheck(retailMulti, summary!.markets);
    const over95 = gap.find((g) => g.market === "Corners" && g.line === "Over 9.5")!;
    expect(over95).toBeDefined();
    // (2.50/2.40 - 1) * 100 = 4.1666... -> 4.2
    expect(over95.gap_pct).toBeCloseTo(4.2, 1);
    const under95 = gap.find((g) => g.market === "Corners" && g.line === "Under 9.5")!;
    expect(under95).toBeDefined();
  });

  it("Asian Handicap: matching lines on both sides produce entries; a Pinnacle-only line is silently skipped", () => {
    const pinnacleAH = [
      {
        fixture: { id: 1565179 },
        bookmakers: [
          {
            id: 4,
            name: "Pinnacle",
            bets: [
              {
                name: "Asian Handicap",
                values: [
                  { value: "Home -0.5", odd: "1.90" },
                  { value: "Away +0.5", odd: "1.90" },
                  { value: "Home -1.0", odd: "2.05" }, // no retail counterpart below
                ],
              },
            ],
          },
        ],
      },
    ];
    const retailAH = [
      {
        bookmakers: [
          {
            name: "10Bet",
            bets: [
              {
                name: "Asian Handicap",
                values: [
                  { value: "Home -0.5", odd: "1.95" },
                  { value: "Away +0.5", odd: "1.85" },
                ],
              },
            ],
          },
        ],
      },
    ];
    const summary = buildPinnacleSummaryFromApiFootball(pinnacleAH);
    const gap = buildStakeGapCheck(retailAH, summary!.markets);
    expect(gap.filter((g) => g.market === "Asian Handicap").length).toBe(2);
    expect(gap.find((g) => g.line === "Home -1.0")).toBeUndefined();
  });

  it("a null/missing odds value on one side never produces a gap_check entry for that line", () => {
    const summary = buildPinnacleSummaryFromApiFootball(pinnacleMulti);
    const retailBadOdds = [
      {
        bookmakers: [
          {
            name: "10Bet",
            bets: [
              {
                name: "Goals Over/Under",
                values: [
                  { value: "Over 2.5", odd: "" }, // unparseable -> toNum returns null
                  { value: "Under 2.5", odd: "1.75" },
                ],
              },
            ],
          },
        ],
      },
    ];
    const gap = buildStakeGapCheck(retailBadOdds, summary!.markets);
    expect(gap.find((g) => g.market === "Over/Under Goals" && g.line === "Over 2.5")).toBeUndefined();
    // The sibling line with valid odds on both sides still produces an entry.
    expect(gap.find((g) => g.market === "Over/Under Goals" && g.line === "Under 2.5")).toBeDefined();
  });
});

describe("OPT 1 — Over/Under 1.5/2.5/3.5 goal lines (C9A + C9B)", () => {
  const oddsWith4Lines = [
    {
      bookmakers: [
        {
          id: 4,
          name: "Pinnacle",
          bets: [
            {
              name: "Goals Over/Under",
              values: [
                { value: "Over 1.5", odd: "1.25" },
                { value: "Under 1.5", odd: "3.75" },
                { value: "Over 2.5", odd: "1.95" },
                { value: "Under 2.5", odd: "1.85" },
                { value: "Over 3.5", odd: "3.40" },
                { value: "Under 3.5", odd: "1.28" },
                { value: "Over 4.5", odd: "6.50" },
                { value: "Under 4.5", odd: "1.08" },
              ],
            },
          ],
        },
      ],
    },
  ];

  it("C9A extractor (extractStakeMarkets): keeps 1.5/2.5/3.5, drops 4.5", () => {
    const res = extractStakeMarkets(oddsWith4Lines);
    const goals = res?.markets["Over/Under 2.5 Goals"];
    expect(goals?.map((v) => v.value)).toEqual([
      "Over 1.5",
      "Under 1.5",
      "Over 2.5",
      "Under 2.5",
      "Over 3.5",
      "Under 3.5",
    ]);
    expect(goals?.some((v) => v.value.includes("4.5"))).toBe(false);
  });

  it("C9B filter (buildPinnacleSummaryFromApiFootball): same mock -> same result", () => {
    const summary = buildPinnacleSummaryFromApiFootball(oddsWith4Lines);
    const ou = summary!.markets.find((m) => m.market === "Over/Under Goals");
    expect(ou!.outcomes.map((o) => o.name)).toEqual([
      "Over 1.5",
      "Under 1.5",
      "Over 2.5",
      "Under 2.5",
      "Over 3.5",
      "Under 3.5",
    ]);
    expect(ou!.outcomes.some((o) => o.name.includes("4.5"))).toBe(false);
  });
});

describe("OPT 2 — Asian Handicap capped to -1.5..+1.5, C9B outcome shape trimmed", () => {
  const wideAhOdds = [
    {
      bookmakers: [
        {
          id: 4,
          name: "Pinnacle",
          bets: [
            {
              name: "Asian Handicap",
              values: [
                { value: "Home -3", odd: "5.00" },
                { value: "Away -3", odd: "1.15" },
                { value: "Home -2", odd: "3.20" },
                { value: "Away -2", odd: "1.35" },
                { value: "Home -1.5", odd: "2.40" },
                { value: "Away -1.5", odd: "1.55" },
                { value: "Home -1", odd: "2.05" },
                { value: "Away -1", odd: "1.72" },
                { value: "Home -0.5", odd: "1.90" },
                { value: "Away -0.5", odd: "1.95" },
                { value: "Home 0", odd: "1.85" },
                { value: "Away 0", odd: "1.95" },
                { value: "Home +0.5", odd: "1.45" },
                { value: "Away +0.5", odd: "2.65" },
                { value: "Home +1", odd: "1.30" },
                { value: "Away +1", odd: "3.30" },
                { value: "Home +1.5", odd: "1.20" },
                { value: "Away +1.5", odd: "4.20" },
                { value: "Home +2", odd: "1.12" },
                { value: "Away +2", odd: "5.50" },
                { value: "Home +3", odd: "1.05" },
                { value: "Away +3", odd: "8.00" },
              ],
            },
          ],
        },
      ],
    },
  ];

  it("C9A extractor (extractStakeMarkets): keeps only -1.5 through +1.5, drops ±2/±3", () => {
    const res = extractStakeMarkets(wideAhOdds);
    const ah = res?.markets["Asian Handicap"];
    expect(ah?.map((v) => v.value)).toEqual([
      "Home -1.5",
      "Away -1.5",
      "Home -1",
      "Away -1",
      "Home -0.5",
      "Away -0.5",
      "Home 0",
      "Away 0",
      "Home +0.5",
      "Away +0.5",
      "Home +1",
      "Away +1",
      "Home +1.5",
      "Away +1.5",
    ]);
  });

  it("C9B filter (buildPinnacleSummaryFromApiFootball): same mock -> same -1.5..+1.5 result", () => {
    const summary = buildPinnacleSummaryFromApiFootball(wideAhOdds);
    const ah = summary!.markets.find((m) => m.market === "Asian Handicap");
    expect(ah!.outcomes.map((o) => o.name)).toEqual([
      "Home -1.5",
      "Away -1.5",
      "Home -1",
      "Away -1",
      "Home -0.5",
      "Away -0.5",
      "Home 0",
      "Away 0",
      "Home +0.5",
      "Away +0.5",
      "Home +1",
      "Away +1",
      "Home +1.5",
      "Away +1.5",
    ]);
    expect(ah!.outcomes.length).toBe(14);
  });

  it("C9B outcome shape: opening/movement_pct/signal are absent from the Claude-facing block, only {name, current} ship", () => {
    const summary = buildPinnacleSummaryFromApiFootball(wideAhOdds);
    // Raw summary still carries the full shape internally (shared with the
    // TheStatsAPI path, which has real opening/movement data) — only the
    // Claude-facing formatDataForClaude output is trimmed.
    expect(summary!.markets[0].outcomes[0]).toHaveProperty("opening");
    expect(summary!.markets[0].outcomes[0]).toHaveProperty("movement_pct");
    expect(summary!.markets[0].outcomes[0]).toHaveProperty("signal");

    const callResults: any = {
      "9B": {
        status: "SUCCESS",
        data: {
          matchId: 1,
          bookmaker: summary!.bookmaker,
          is_pinnacle: summary!.is_pinnacle,
          source: "API-Football bookmaker=4",
          markets: summary!.markets,
          gap_check: [],
          note: "note",
        },
      },
    };
    const full = formatDataForClaude(callResults);
    const block = full.match(/\[CALL 9B[\s\S]*?\[END CALL 9B\]/)?.[0] ?? "";
    // The header line itself contains the literal phrase "{name, current}", so
    // parse from the JSON line only (everything after the header's newline),
    // not a naive first-"{"-to-last-"}" match.
    const jsonLine = block.split("\n")[1];
    const shippedJson = JSON.parse(jsonLine);
    const shippedOutcome = shippedJson.markets[0].outcomes[0];
    expect(shippedOutcome).toEqual({ name: expect.any(String), current: expect.any(Number) });
    expect(shippedOutcome).not.toHaveProperty("opening");
    expect(shippedOutcome).not.toHaveProperty("movement_pct");
    expect(shippedOutcome).not.toHaveProperty("signal");
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

// ─────────────────────────────────────────────────────────────
// EDGE-FIX tier 8.3 — cards market rollout
// The Pinnacle bookmaker=4 feed verifiably carries "Cards Over/Under" (and
// "Cards Asian Handicap") for WC2026 even though the retail feed carries no
// cards at all. The C9B extractor now ships a "Cards" market so a REAL cards
// price reaches Claude; cards-AH must never be misfiled into the goals
// Asian Handicap market.
// ─────────────────────────────────────────────────────────────
describe("tier 8.3 — C9B cards extraction (Pinnacle bookmaker=4)", () => {
  const cardsResponse = [
    {
      fixture: { id: 1565179 },
      bookmakers: [
        {
          id: 4,
          name: "Pinnacle",
          bets: [
            {
              // Cards AH listed FIRST deliberately: it must not be captured
              // as the goals "Asian Handicap" market (misfiling guard).
              name: "Cards Asian Handicap",
              values: [
                { value: "Home -1.5", odd: "1.88" },
                { value: "Away -1.5", odd: "1.92" },
              ],
            },
            {
              name: "Cards Over/Under",
              values: [
                { value: "Over 2.5", odd: "1.60" },
                { value: "Under 2.5", odd: "2.30" },
                { value: "Over 3.5", odd: "2.10" },
                { value: "Under 3.5", odd: "1.70" },
                { value: "Over 5.5", odd: "4.50" }, // outside 2.5/3.5/4.5 cap → dropped
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

  it("ships a Cards market with real prices, line-capped to 2.5/3.5/4.5", () => {
    const summary = buildPinnacleSummaryFromApiFootball(cardsResponse);
    expect(summary).not.toBeNull();
    const cards = summary!.markets.find((m) => m.market === "Cards");
    expect(cards).toBeDefined();
    const names = cards!.outcomes.map((o) => o.name);
    expect(names).toEqual(["Over 2.5", "Under 2.5", "Over 3.5", "Under 3.5"]);
    const over35 = cards!.outcomes.find((o) => o.name === "Over 3.5");
    expect(over35!.current).toBe(2.1);
    // Same no-history contract as every other C9B market.
    for (const o of cards!.outcomes) {
      expect(o.opening).toBeNull();
      expect(o.movement_pct).toBeNull();
    }
  });

  it("never misfiles 'Cards Asian Handicap' into the goals Asian Handicap market", () => {
    const summary = buildPinnacleSummaryFromApiFootball(cardsResponse);
    const ah = summary!.markets.find((m) => m.market === "Asian Handicap");
    expect(ah).toBeDefined();
    // Only the genuine goals-AH values survive — the cards-AH values (1.88 /
    // 1.92 on the -1.5 line) must not appear.
    expect(ah!.outcomes.map((o) => o.name)).toEqual(["Home -0.5", "Away +0.5"]);
    // Cards-AH is intentionally not shipped as its own market either.
    expect(summary!.markets.map((m) => m.market)).not.toContain("Cards Asian Handicap");
  });

  it("gap check pairs Cards when the retail feed ever carries a cards price", () => {
    const retailWithCards = [
      {
        bookmakers: [
          {
            id: 22,
            name: "Stake",
            bets: [
              {
                name: "Cards Over/Under",
                values: [
                  { value: "Over 3.5", odd: "2.20" },
                  { value: "Under 3.5", odd: "1.65" },
                ],
              },
            ],
          },
        ],
      },
    ];
    const summary = buildPinnacleSummaryFromApiFootball(cardsResponse);
    const gap = buildStakeGapCheck(retailWithCards, summary!.markets);
    const cardsGap = gap.filter((g) => g.market === "Cards");
    expect(cardsGap.length).toBe(2);
    const over = cardsGap.find((g) => g.line === "Over 3.5");
    // (2.20 / 2.10 - 1) * 100 = 4.8 (1dp)
    expect(over!.gap_pct).toBeCloseTo(4.8, 1);
    expect(over!.verdict).toBe("STAKE OFFERS VALUE vs PINNACLE");
  });

  it("no cards bet in the feed → no Cards market (absence is data, never zero)", () => {
    const summary = buildPinnacleSummaryFromApiFootball(pinnacleResponse);
    expect(summary!.markets.map((m) => m.market)).not.toContain("Cards");
  });
});
