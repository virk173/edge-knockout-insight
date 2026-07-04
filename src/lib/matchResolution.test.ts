import { describe, it, expect } from "vitest";
import { findStatsApiMatchInList } from "./analyse";
import { detectDeadRubber } from "./calculate";

// EDGE-FIX tier 4 — S0 match resolution + dead-rubber clinch tiebreak.

const mt = (id: string, home: string, away: string) => ({
  id,
  home_team: { id: `${id}h`, name: home },
  away_team: { id: `${id}a`, name: away },
});

describe("findStatsApiMatchInList — two-sided pair matching", () => {
  it("substring nations no longer cross-match: Niger does not resolve a Nigeria fixture", () => {
    const list = [mt("m1", "Nigeria", "Ghana")];
    expect(findStatsApiMatchInList(list, "Niger", "Cameroon")).toBeUndefined();
  });

  it("one-sided hits no longer resolve: target away name in an unrelated fixture", () => {
    // Old logic matched m1 because an.includes(away) alone was sufficient.
    const list = [mt("m1", "Brazil", "Ecuador")];
    expect(findStatsApiMatchInList(list, "Mexico", "Ecuador")).toBeUndefined();
  });

  it("exact pair wins over a looser contains candidate listed first", () => {
    const list = [
      mt("loose", "Korea DPR", "Japan"), // contains-level candidate for "Korea"
      mt("exact", "Korea Republic", "Japan"),
    ];
    const found = findStatsApiMatchInList(list, "Korea Republic", "Japan") as ReturnType<typeof mt>;
    expect(found?.id).toBe("exact");
  });

  it("contains pair still works for naming variants (United States vs Bosnia)", () => {
    const list = [mt("m1", "United States", "Bosnia and Herzegovina")];
    const found = findStatsApiMatchInList(list, "United States", "Bosnia") as ReturnType<typeof mt>;
    expect(found?.id).toBe("m1");
  });

  // AUDIT FIX — alias table: cross-API naming conventions for the same nation
  // now resolve via canonicalization in the exact pass (the strict two-sided
  // design is unchanged; these spellings are taught to be the same country).
  it("alias: USA resolves a United States fixture (and stays two-sided)", () => {
    const list = [mt("m1", "United States", "Bosnia and Herzegovina")];
    const found = findStatsApiMatchInList(list, "USA", "Bosnia") as ReturnType<typeof mt>;
    expect(found?.id).toBe("m1");
    // Two-sided still enforced: right home alias + wrong away → no match.
    expect(findStatsApiMatchInList(list, "USA", "Cameroon")).toBeUndefined();
  });

  it("alias: South Korea resolves a Korea Republic fixture; Korea DPR does not", () => {
    const list = [
      mt("dpr", "Korea DPR", "Japan"),
      mt("rep", "Korea Republic", "Japan"),
    ];
    const found = findStatsApiMatchInList(list, "South Korea", "Japan") as ReturnType<typeof mt>;
    expect(found?.id).toBe("rep");
  });

  it("alias: Ivory Coast resolves a Côte d'Ivoire fixture (accent-stripped)", () => {
    const list = [mt("m1", "Côte d'Ivoire", "Norway")];
    const found = findStatsApiMatchInList(list, "Ivory Coast", "Norway") as ReturnType<typeof mt>;
    expect(found?.id).toBe("m1");
  });

  it("swapped home/away still resolves", () => {
    const list = [mt("m1", "France", "Senegal")];
    const found = findStatsApiMatchInList(list, "Senegal", "France") as ReturnType<typeof mt>;
    expect(found?.id).toBe("m1");
  });
});

describe("detectDeadRubber — clinch requires safety against tiebreak overtakes", () => {
  const standings = (rows: Array<[string, number, number, number]>) =>
    rows.map(([team_id, points, position, matches_played]) => ({
      team_id,
      points,
      position,
      matches_played,
      goal_difference: 0,
      goals_for: 0,
    }));

  it("TWO rivals able to EQUAL the opponent's points block the clinch (GD overtakes can push to 3rd)", () => {
    // Opponent leads with 6 pts after 2 games. Rivals B and C both have 3 pts
    // with 1 game left (max 6 each = both can EQUAL → both may overtake on
    // GD → worst case opponent finishes 3rd). Old logic counted only rivals
    // STRICTLY above (none) → wrongly clinched → false dead rubber. New: two
    // at-or-above rivals → NOT clinched.
    const r = detectDeadRubber({
      fixture_matchday: 3,
      fixture_date: "2026-06-25T00:00:00Z",
      opponent_team_id: "OPP",
      opponent_group_standings: standings([
        ["OPP", 6, 1, 2],
        ["B", 3, 2, 2],
        ["C", 3, 3, 2],
        ["D", 0, 4, 2],
      ]),
      all_groups_third_place_table: [],
      group_total_matchdays: 3,
    });
    expect(r.comparison.clinched_top2).toBe(false);
    expect(r.is_dead_rubber).toBe(false);
  });

  it("still clinches when at most one rival can even reach the opponent's points", () => {
    // Opponent 7 pts. B max = 4+3 = 7 (can equal — the ONE allowed maybe-above
    // rival). C max 4, D max 3. Worst case opponent finishes 2nd → clinched.
    const r = detectDeadRubber({
      fixture_matchday: 3,
      fixture_date: "2026-06-25T00:00:00Z",
      opponent_team_id: "OPP",
      opponent_group_standings: standings([
        ["OPP", 7, 1, 2],
        ["B", 4, 2, 2],
        ["C", 1, 3, 2],
        ["D", 0, 4, 2],
      ]),
      all_groups_third_place_table: [],
      group_total_matchdays: 3,
    });
    expect(r.comparison.clinched_top2).toBe(true);
    expect(r.is_dead_rubber).toBe(true);
  });
});
