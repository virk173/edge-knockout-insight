import { describe, it, expect } from "vitest";
import { generateRunReport } from "@/lib/runReport";
import {
  CARDS_UNAVAILABLE_LABEL,
  CARDS_MARKET_SOURCE_AVAILABLE,
} from "@/lib/dataGaps";

// The RETAIL odds feed (API-Football default) does not carry cards markets —
// only the Pinnacle bookmaker=4 feed does (tier 8.3). When no retail cards
// price exists the Run Report must render an explicit UNAVAILABLE label, NOT
// a bare "N/A" (which means a transient per-run failure). See src/lib/dataGaps.ts.

describe("runReport — cards data gap labeling", () => {
  // A minimal live collection with a C9 odds payload that carries 1X2 but no
  // cards market (mirrors the real feed).
  const callStatuses = {
    callResults: {
      "9": {
        status: "SUCCESS",
        data: {
          stakeOdds: [
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
                        { value: "Away", odd: "4.20" },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    },
  } as unknown as Parameters<typeof generateRunReport>[3];

  const report = generateRunReport(
    "Portugal vs Croatia",
    "Round of 16",
    "2026-07-02T18:00:00Z",
    callStatuses,
    null,
    "",
    new Date("2026-07-02T12:00:00Z"),
    { home: "Portugal", away: "Croatia", fixtureId: 123 },
  );

  it("renders the explicit UNAVAILABLE cards label, not N/A", () => {
    expect(CARDS_MARKET_SOURCE_AVAILABLE).toBe(true);
    expect(report).toContain(`Cards 3.5 over: ${CARDS_UNAVAILABLE_LABEL}`);
    // Guard against a silent regression back to a bare N/A for cards.
    expect(report).not.toContain("Cards 3.5 over: N/A");
  });

  it("labels the C9A source as the actual bookmaker, not 'Stake'", () => {
    expect(report).toContain("C9A Odds — source: 10Bet");
    expect(report).not.toContain("C9A Stake odds:");
  });
});

// The "Over/Under 2.5 Goals" extract bucket also carries the 1.5 and 3.5
// lines (OPT 1 widened the valueFilter). A side-only matcher printed the
// FIRST over/under rows — the 1.5-line prices — under the "Over 2.5" label
// (live run 2026-07-05: "Over 2.5: 1.20 Under 2.5: 4.33" were the 1.5 line;
// the true 2.5 prices were 1.62/2.30). The label must pin the line.
describe("runReport — C9A goals prices pin the 2.5 line", () => {
  const callStatuses = {
    callResults: {
      "9": {
        status: "SUCCESS",
        data: {
          stakeOdds: [
            {
              bookmakers: [
                {
                  name: "10Bet",
                  bets: [
                    {
                      name: "Goals Over/Under",
                      // Feed order puts the 1.5 line first, as live.
                      values: [
                        { value: "Over 1.5", odd: "1.20" },
                        { value: "Under 1.5", odd: "4.33" },
                        { value: "Over 2.5", odd: "1.62" },
                        { value: "Under 2.5", odd: "2.30" },
                        { value: "Over 3.5", odd: "2.58" },
                        { value: "Under 3.5", odd: "1.50" },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    },
  } as unknown as Parameters<typeof generateRunReport>[3];

  const report = generateRunReport(
    "Brazil vs Norway",
    "Round of 16",
    "2026-07-05T20:00:00Z",
    callStatuses,
    null,
    "",
    new Date("2026-07-05T19:00:00Z"),
    { home: "Brazil", away: "Norway", fixtureId: 1568100 },
  );

  it("prints the 2.5-line prices, not the first (1.5) line in the bucket", () => {
    expect(report).toContain("Over 2.5: 1.62 Under 2.5: 2.30");
    expect(report).not.toContain("Over 2.5: 1.20");
    expect(report).not.toContain("Under 2.5: 4.33");
  });
});
