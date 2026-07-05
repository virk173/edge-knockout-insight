import { describe, it, expect } from "vitest";
import { extractStakeMarkets } from "./analyse";

// Mimics the API-Football /odds (Stake) payload shape consumed by
// extractStakeMarkets: response[] -> bookmakers[] -> bets[] -> values[].
const rawOddsPayload = [
  {
    bookmakers: [
      {
        name: "Stake",
        bets: [
          {
            name: "Match Winner",
            values: [
              { value: "Home", odd: "1.80" },
              { value: "Draw", odd: "3.50" },
              { value: "Away", odd: "4.20" },
            ],
          },
          {
            name: "Goals Over/Under",
            values: [
              { value: "Over 2.5", odd: "1.95" },
              { value: "Under 2.5", odd: "1.90" },
            ],
          },
          {
            name: "Corners Over/Under",
            values: [
              { value: "Over 8.5", odd: "1.70" },
              { value: "Over 9.5", odd: "2.05" },
              { value: "Under 9.5", odd: "1.78" },
              { value: "Over 10.5", odd: "2.60" },
            ],
          },
          {
            name: "Cards Over/Under",
            values: [
              { value: "Over 2.5", odd: "1.60" },
              { value: "Over 3.5", odd: "2.30" },
              { value: "Under 3.5", odd: "1.62" },
              { value: "Over 4.5", odd: "3.40" },
            ],
          },
        ],
      },
    ],
  },
];

describe("extractStakeMarkets — cards & corners lines", () => {
  it("extracts the cards market (2.5/3.5/4.5) so a cards bet can be proposed", () => {
    const res = extractStakeMarkets(rawOddsPayload);
    const cards = res?.markets["Cards Over/Under"];
    expect(cards).toBeDefined();
    const over35 = cards?.find(
      (v) => v.value.toLowerCase().includes("over") && v.value.includes("3.5"),
    );
    expect(over35?.odd).toBe("2.30");
    // 2.5 and 4.5 also captured when present at no extra cost.
    expect(cards?.some((v) => v.value.includes("2.5"))).toBe(true);
    expect(cards?.some((v) => v.value.includes("4.5"))).toBe(true);
  });

  it("extracts corners 8.5/9.5/10.5, not just 9.5", () => {
    const res = extractStakeMarkets(rawOddsPayload);
    const corners = res?.markets["Corners Over/Under"];
    expect(corners).toBeDefined();
    expect(corners?.some((v) => v.value.includes("8.5"))).toBe(true);
    expect(corners?.some((v) => v.value.includes("9.5"))).toBe(true);
    expect(corners?.some((v) => v.value.includes("10.5"))).toBe(true);
  });

  it("leaves existing markets (1X2, O/U 2.5, corners primary line) intact", () => {
    const res = extractStakeMarkets(rawOddsPayload);
    expect(res?.bookmaker).toBe("Stake");
    expect(res?.markets["1X2 (Match Winner)"]?.length).toBe(3);
    const over25 = res?.markets["Over/Under 2.5 Goals"]?.find((v) =>
      v.value.toLowerCase().includes("over"),
    );
    expect(over25?.odd).toBe("1.95");
  });
});

// ─────────────────────────────────────────────────────────────
// extractConsensusOdds — median across all bookmakers
// ─────────────────────────────────────────────────────────────
import { extractConsensusOdds } from "./analyse";

describe("extractConsensusOdds", () => {
  const multiBook = [
    {
      bookmakers: [
        {
          name: "10Bet",
          bets: [
            {
              name: "Match Winner",
              values: [{ value: "Home", odd: "1.80" }],
            },
            {
              name: "Cards Over/Under",
              // The live-E2E placeholder pattern: both sides equal.
              values: [{ value: "Under 3.5", odd: "1.83" }],
            },
          ],
        },
        {
          name: "Bet365",
          bets: [
            { name: "Match Winner", values: [{ value: "Home", odd: "1.78" }] },
            { name: "Cards Over/Under", values: [{ value: "Under 3.5", odd: "1.50" }] },
          ],
        },
        {
          name: "Pinnacle",
          bets: [
            { name: "Match Winner", values: [{ value: "Home", odd: "1.79" }] },
            { name: "Cards Over/Under", values: [{ value: "Under 3.5", odd: "1.46" }] },
          ],
        },
      ],
    },
  ];

  it("computes the per-outcome median and book counts", () => {
    const c = extractConsensusOdds(multiBook);
    expect(c?.books_counted).toBe(3);
    const home = c?.markets["1X2 (Match Winner)"]?.find((v) => v.value === "Home");
    expect(home?.median_odd).toBe(1.79);
    expect(home?.books).toBe(3);
    // The stale 1.83 outlier does not drag the median to itself.
    const cards = c?.markets["Cards Over/Under"]?.find((v) => v.value === "Under 3.5");
    expect(cards?.median_odd).toBe(1.5);
  });

  it("returns null for empty/malformed payloads and ignores junk odds", () => {
    expect(extractConsensusOdds(null)).toBeNull();
    expect(extractConsensusOdds([])).toBeNull();
    const junk = [
      {
        bookmakers: [
          {
            name: "X",
            bets: [{ name: "Match Winner", values: [{ value: "Home", odd: "0.5" }] }],
          },
        ],
      },
    ];
    expect(extractConsensusOdds(junk)).toBeNull();
  });
});

describe("extractConsensusOdds — sibling bet types must not pool", () => {
  it("takes only the first matching bet per label per bookmaker", () => {
    // Live E2E round 2: '1st Half Winner' / 'Result-BTTS' style siblings
    // matched the same WANTED spec and poisoned the medians.
    const payload = [
      {
        bookmakers: [
          {
            name: "BookA",
            bets: [
              { name: "Match Winner", values: [{ value: "Away", odd: "4.50" }] },
              // Sibling that also contains a matching name pattern with a
              // much shorter price — must be IGNORED for the consensus.
              { name: "Match Winner", values: [{ value: "Away", odd: "2.10" }] },
            ],
          },
          {
            name: "BookB",
            bets: [
              { name: "Match Winner", values: [{ value: "Away", odd: "4.70" }] },
            ],
          },
        ],
      },
    ];
    const c = extractConsensusOdds(payload);
    const away = c?.markets["1X2 (Match Winner)"]?.find((v) => v.value === "Away");
    expect(away?.books).toBe(2);
    expect(away?.median_odd).toBe(4.6);
  });
});
