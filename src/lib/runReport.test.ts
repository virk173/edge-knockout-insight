import { describe, it, expect } from "vitest";
import { generateRunReport } from "@/lib/runReport";
import {
  CARDS_UNAVAILABLE_LABEL,
  CARDS_MARKET_SOURCE_AVAILABLE,
} from "@/lib/dataGaps";

// The odds source (API-Football) does not carry cards markets at all — this is
// a permanent data gap, verified live. The Run Report must render an explicit
// UNAVAILABLE label for cards, NOT a bare "N/A" (which means a transient
// per-run failure). See src/lib/dataGaps.ts.

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
    expect(CARDS_MARKET_SOURCE_AVAILABLE).toBe(false);
    expect(report).toContain(`Cards 3.5 over: ${CARDS_UNAVAILABLE_LABEL}`);
    // Guard against a silent regression back to a bare N/A for cards.
    expect(report).not.toContain("Cards 3.5 over: N/A");
  });

  it("labels the C9A source as the actual bookmaker, not 'Stake'", () => {
    expect(report).toContain("C9A Odds — source: 10Bet");
    expect(report).not.toContain("C9A Stake odds:");
  });
});
