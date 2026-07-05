import { describe, it, expect } from "vitest";
import {
  extractTeamCornersFromStats,
  summariseRecentCorners,
  formatDataForClaude,
  type CallResult,
} from "./analyse";

// ─────────────────────────────────────────────────────────────
// EDGE-FIX tier 8.2 — conditional recent-5 corners
// /fixtures/statistics is fetched only when a corners market is evaluable;
// these tests cover the pure extraction/averaging and the CALL 4 injection.
// ─────────────────────────────────────────────────────────────

// API-Football /fixtures/statistics response: one block per team.
const statsFixture = (
  homeId: number,
  homeCorners: number | string | null,
  awayId: number,
  awayCorners: number | string | null,
) => [
  {
    team: { id: homeId, name: `team-${homeId}` },
    statistics: [
      { type: "Shots on Goal", value: 5 },
      { type: "Corner Kicks", value: homeCorners },
    ],
  },
  {
    team: { id: awayId, name: `team-${awayId}` },
    statistics: [{ type: "Corner Kicks", value: awayCorners }],
  },
];

describe("tier 8.2 — extractTeamCornersFromStats", () => {
  it("reads the team's corners for and the opponent's as against", () => {
    const c = extractTeamCornersFromStats(statsFixture(10, 7, 20, 3), 10);
    expect(c).toEqual({ corners_for: 7, corners_against: 3 });
    const away = extractTeamCornersFromStats(statsFixture(10, 7, 20, 3), 20);
    expect(away).toEqual({ corners_for: 3, corners_against: 7 });
  });

  it("string values are parsed; a present-but-null corner stat is a real 0 (API-Football reports zero counts as null)", () => {
    const c = extractTeamCornersFromStats(statsFixture(10, "6", 20, null), 10);
    expect(c).toEqual({ corners_for: 6, corners_against: 0 });
    expect(extractTeamCornersFromStats(statsFixture(10, null, 20, 4), 10)).toEqual({
      corners_for: 0,
      corners_against: 4,
    });
  });

  it("team not in the response / malformed response → null, never a guess", () => {
    expect(extractTeamCornersFromStats(statsFixture(10, 7, 20, 3), 99)).toBeNull();
    expect(extractTeamCornersFromStats([], 10)).toBeNull();
    expect(extractTeamCornersFromStats(null, 10)).toBeNull();
  });
});

describe("tier 8.2 — summariseRecentCorners", () => {
  it("averages only the team's own fixtures, one decimal place", () => {
    const statsByFixture = [
      { fixtureId: 1, stats: statsFixture(10, 7, 20, 3) },
      { fixtureId: 2, stats: statsFixture(30, 2, 10, 4) },
      { fixtureId: 3, stats: statsFixture(40, 9, 50, 8) }, // not team 10's fixture
    ];
    const s = summariseRecentCorners(statsByFixture, 10, [1, 2]);
    // for: (7 + 4) / 2 = 5.5 ; against: (3 + 2) / 2 = 2.5
    expect(s).toEqual({
      corners_for_avg: 5.5,
      corners_against_avg: 2.5,
      fixtures_counted: 2,
    });
  });

  it("present-but-null corner rows count as a real 0 (API-Football reports zero counts as null)", () => {
    const statsByFixture = [
      { fixtureId: 1, stats: statsFixture(10, 6, 20, 4) },
      { fixtureId: 2, stats: statsFixture(30, null, 10, null) }, // 0-corner match
    ];
    const s = summariseRecentCorners(statsByFixture, 10, [1, 2]);
    expect(s).toEqual({
      corners_for_avg: 3,
      corners_against_avg: 2,
      fixtures_counted: 2,
    });
  });

  it("no usable fixture → null (caller records EMPTY)", () => {
    expect(summariseRecentCorners([], 10, [1, 2])).toBeNull();
  });
});

describe("tier 8.2 — CALL 4 block carries the recent-5 corners injection", () => {
  const baseResults: Record<string, CallResult> = {
    "4-1": {
      key: "4-1",
      label: "recent form home",
      status: "SUCCESS",
      data: [
        {
          fixture: { id: 1, date: "2026-06-20T18:00:00Z" },
          league: { round: "Group D - 3" },
          teams: { home: { id: 10, name: "France" }, away: { id: 20, name: "Niger" } },
          goals: { home: 3, away: 0 },
        },
      ],
    },
  };

  it("SUCCESS 4C data is appended inside the CALL 4 block", () => {
    const out = formatDataForClaude({
      ...baseResults,
      "4C": {
        key: "4C",
        label: "Recent-5 corners",
        status: "SUCCESS",
        data: {
          home: { team: "France", corners_for_avg: 6.2, corners_against_avg: 3.1, fixtures_counted: 5 },
          away: null,
          note: "APP-COMPUTED recent-5 corners",
        },
      },
    });
    const call4 = out.split("[END CALL 4]")[0];
    expect(call4).toContain("RECENT-5 CORNERS");
    expect(call4).toContain('"corners_for_avg": 6.2');
    // The injection rides the CALL 4 block — never its own CALL block.
    expect(out).not.toContain("[CALL 4C");
  });

  it("skipped/absent 4C → no corners section (absence of data, never zeros)", () => {
    const out = formatDataForClaude(baseResults);
    expect(out).not.toContain("RECENT-5 CORNERS");
  });
});

// ─────────────────────────────────────────────────────────────
// Recent-5 TEAM STATS from the same /fixtures/statistics responses
// ─────────────────────────────────────────────────────────────
import { summariseRecentTeamStats } from "./analyse";

describe("summariseRecentTeamStats", () => {
  const richStats = (homeId: number, awayId: number) => [
    {
      team: { id: homeId, name: `team-${homeId}` },
      statistics: [
        { type: "Shots on Goal", value: 6 },
        { type: "Ball Possession", value: "62%" },
        { type: "Yellow Cards", value: 2 },
        { type: "Fouls", value: 11 },
        { type: "Corner Kicks", value: 7 },
      ],
    },
    {
      team: { id: awayId, name: `team-${awayId}` },
      statistics: [
        { type: "Shots on Goal", value: 3 },
        { type: "Ball Possession", value: "38%" },
        { type: "Yellow Cards", value: 3 },
        { type: "Fouls", value: 15 },
      ],
    },
  ];

  it("averages SOT/possession/yellows/fouls for the team's own fixtures", () => {
    const s = summariseRecentTeamStats(
      [
        { fixtureId: 1, stats: richStats(10, 20) },
        { fixtureId: 2, stats: richStats(10, 30) },
      ],
      10,
      [1, 2],
    );
    expect(s).toEqual({
      shots_on_target_avg: 6,
      possession_avg_pct: 62,
      yellows_avg: 2,
      fouls_avg: 11,
      fixtures_counted: 2,
    });
    // Possession "%" strings parse; the away perspective reads its own block.
    const away = summariseRecentTeamStats(
      [{ fixtureId: 1, stats: richStats(10, 20) }],
      20,
      [1],
    );
    expect(away?.possession_avg_pct).toBe(38);
    expect(away?.fouls_avg).toBe(15);
  });

  it("returns null when the team appears in no fixture; missing stat types stay null", () => {
    expect(summariseRecentTeamStats([], 10, [1])).toBeNull();
    const noSot = [
      {
        fixtureId: 1,
        stats: [
          { team: { id: 10 }, statistics: [{ type: "Corner Kicks", value: 5 }] },
          { team: { id: 20 }, statistics: [] },
        ],
      },
    ];
    const s = summariseRecentTeamStats(noSot, 10, [1]);
    expect(s?.shots_on_target_avg).toBeNull();
    expect(s?.fixtures_counted).toBe(1);
  });
});
