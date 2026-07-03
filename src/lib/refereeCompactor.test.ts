import { describe, it, expect } from "vitest";
import { formatDataForClaude } from "./analyse";

// OPT 4 — C7 previously had no compactor (passed through unchanged). These
// tests exercise the new compactReferee() indirectly via formatDataForClaude,
// the same convention used for the other per-call compactors in this file
// (compactInjuries, compactLineup, compactPredictions are not exported either).

function c7Block(rawProfile: unknown) {
  const full = formatDataForClaude({
    "7": { status: "SUCCESS", data: rawProfile } as any,
  });
  const block = full.match(/\[CALL 7[\s\S]*?\[END CALL 7\]/)?.[0] ?? "";
  // C7 is pretty-printed (2-space indent), so the JSON spans multiple lines —
  // strip the header line and the trailing "[END CALL 7]" marker.
  const lines = block.split("\n");
  const jsonText = lines.slice(1, -1).join("\n");
  return JSON.parse(jsonText);
}

describe("OPT 4 — compactReferee via C7", () => {
  it("keeps only the 8 fields, dropping career_totals/seasons_used/sample_fixtures_with_stats and any other extras", () => {
    const raw = {
      referee: "Felix Zwayer",
      matches_officiated: 62,
      seasons_used: [2026, 2022],
      avg_yellow_cards_per_game: 4.2,
      avg_fouls_per_game: 22.1,
      penalties_awarded: 7,
      sample_fixtures_with_stats: 8,
      source: "TheStatsAPI /referee (yellows from career) + API-Football history (fouls/penalties)",
      career_totals: { games: 62, yellow_cards: 260, red_cards: 4, yellow_red_cards: 2 },
      some_unexpected_extra_field: "should not appear",
    };
    const out = c7Block(raw);
    expect(Object.keys(out).sort()).toEqual(
      [
        "name",
        "career_games",
        "yellows_per_game",
        "fouls_per_game",
        "penalties_per_game",
        "strictness_score",
        "strictness_label",
        "source",
      ].sort(),
    );
    expect(out.name).toBe("Felix Zwayer");
    expect(out.career_games).toBe(62);
    expect(out.yellows_per_game).toBe(4.2);
    expect(out.fouls_per_game).toBe(22.1);
    expect(out.penalties_per_game).toBe(7);
    expect(out.source).toBe("TheStatsAPI");
  });

  it("strictness_label: >=50 HIGH — score = (yellows*10) + (fouls*2) + (pens*15)", () => {
    // (3.42*10) + (17*2) + (0*15) = 34.2 + 34 + 0 = 68.2 -> round 68 -> HIGH
    const out = c7Block({
      referee: "Ref A",
      matches_officiated: 10,
      avg_yellow_cards_per_game: 3.42,
      avg_fouls_per_game: 17,
      penalties_awarded: 0,
    });
    expect(out.strictness_score).toBe(68);
    expect(out.strictness_label).toBe("HIGH");
  });

  it("strictness_label: 30-49 MEDIUM", () => {
    // (1.0*10) + (10*2) + (0*15) = 10 + 20 + 0 = 30 -> MEDIUM
    const out = c7Block({
      referee: "Ref B",
      matches_officiated: 10,
      avg_yellow_cards_per_game: 1.0,
      avg_fouls_per_game: 10,
      penalties_awarded: 0,
    });
    expect(out.strictness_score).toBe(30);
    expect(out.strictness_label).toBe("MEDIUM");
  });

  it("strictness_label: <30 LOW", () => {
    // (1*10) + (5*2) + (0*15) = 10 + 10 + 0 = 20 -> LOW
    const out = c7Block({
      referee: "Ref C",
      matches_officiated: 10,
      avg_yellow_cards_per_game: 1,
      avg_fouls_per_game: 5,
      penalties_awarded: 0,
    });
    expect(out.strictness_score).toBe(20);
    expect(out.strictness_label).toBe("LOW");
  });

  it("a missing stat contributes 0, not a failure — fouls/pens null but yellows present still scores", () => {
    // (2*10) + (0) + (0) = 20 -> LOW
    const out = c7Block({
      referee: "Ref D",
      matches_officiated: 10,
      avg_yellow_cards_per_game: 2,
      avg_fouls_per_game: "NOT_AVAILABLE",
      penalties_awarded: "NOT_AVAILABLE",
    });
    expect(out.strictness_score).toBe(20);
    expect(out.strictness_label).toBe("LOW");
  });

  it("NOT_AVAILABLE sentinel on ALL THREE inputs yields null, never a fabricated 0", () => {
    const out = c7Block({
      referee: "Ref F",
      matches_officiated: 5,
      avg_yellow_cards_per_game: "NOT_AVAILABLE",
      avg_fouls_per_game: "NOT_AVAILABLE",
      penalties_awarded: "NOT_AVAILABLE",
    });
    expect(out.yellows_per_game).toBeNull();
    expect(out.fouls_per_game).toBeNull();
    expect(out.penalties_per_game).toBeNull();
    expect(out.strictness_score).toBeNull();
    expect(out.strictness_label).toBeNull();
  });

  it("source normalizes API-Football-only fallback (profile.source undefined) to 'API-Football'", () => {
    const out = c7Block({ referee: "Ref G", matches_officiated: 5, avg_yellow_cards_per_game: 3.5 });
    expect(out.source).toBe("API-Football");
  });
});
