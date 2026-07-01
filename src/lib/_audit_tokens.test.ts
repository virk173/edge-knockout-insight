import { describe, it } from "vitest";
import { formatDataForClaude, type CallResult } from "./analyse";
import { SYSTEM_PROMPT } from "./systemPrompt";

function afFixture(i: number) {
  return {
    fixture: { id: 1567300 + i, referee: "Szymon Marciniak, Poland", timezone: "UTC",
      date: `2026-06-2${i}T18:00:00+00:00`, timestamp: 1782000000 + i * 86400,
      periods: { first: 1782000000, second: 1782003600 },
      venue: { id: 556, name: "MetLife Stadium", city: "East Rutherford" },
      status: { long: "Match Finished", short: "FT", elapsed: 90 } },
    league: { id: 1, name: "World Cup", country: "World", logo: "https://media.api-sports.io/football/leagues/1.png", flag: null, season: 2026, round: "Round of 16" },
    teams: { home: { id: 2382, name: "Home Team", logo: "https://media.api-sports.io/football/teams/2382.png", winner: true },
      away: { id: 25, name: "Away Team", logo: "https://media.api-sports.io/football/teams/25.png", winner: false } },
    goals: { home: 2, away: 1 },
    score: { halftime: { home: 1, away: 0 }, fulltime: { home: 2, away: 1 }, extratime: { home: null, away: null }, penalty: { home: null, away: null } },
  };
}
function saTeamStatsStored() {
  return { teamId: "tm_123",
    extracted: { form: "WWDLW", goals_for: 9, goals_against: 4, wins: 3, draws: 1, losses: 1, matches_played: 5, position: null },
    raw: { team_id: "tm_123", matches_played: 5, wins: 3, draws: 1, losses: 1, form: "WWDLW",
      goals: { for: 9, against: 4, for_avg: 1.8, against_avg: 0.8, per_half: { first: 5, second: 4 } },
      shooting: { total_shots: 68, shots_on_target: 31, shots_off_target: 25, blocked: 12, conversion_rate: 0.13, per_game: 13.6 },
      passing: { total: 2450, completed: 2010, accuracy: 0.82, key_passes: 44, crosses: 78, long_balls: 210 },
      possession: { avg: 0.54, home_avg: 0.57, away_avg: 0.51 },
      defending: { tackles: 92, interceptions: 71, clearances: 130, blocks: 24, duels_won: 210, aerials_won: 88 },
      discipline: { yellow_cards: 11, red_cards: 1, fouls: 62, fouls_drawn: 58 },
      xg: { for: 8.4, against: 4.9, per_game_for: 1.68, per_game_against: 0.98 } } };
}
function afInjury(i: number) {
  return { player: { id: 1000 + i, name: `Player ${i}`, photo: `https://media.api-sports.io/football/players/${1000 + i}.png`, type: "Missing Fixture", reason: "Muscle Injury" },
    team: { id: 2382, name: "Home Team", logo: "https://media.api-sports.io/football/teams/2382.png" },
    fixture: { id: 1567308, timezone: "UTC", date: "2026-06-30T18:00:00+00:00", timestamp: 1782000000 },
    league: { id: 1, season: 2026, name: "World Cup", country: "World", logo: "x", flag: null } };
}
function afPredictions() {
  return { predictions: { winner: { id: 2382, name: "Home Team", comment: "Win or draw" }, win_or_draw: true, under_over: "-2.5",
      goals: { home: "-1.5", away: "-1.5" }, advice: "Combo Double chance : Home Team or draw and -3.5 goals", percent: { home: "45%", draw: "30%", away: "25%" } },
    league: { id: 1, name: "World Cup", country: "World", logo: "x", flag: null, season: 2026 },
    teams: { home: { id: 2382, name: "Home Team", logo: "x", last_5: { played: 5, form: "80%", att: "70%", def: "60%", goals: { for: { total: 9, average: 1.8 }, against: { total: 4, average: 0.8 } } }, league: { form: "WWDLW", fixtures: { played: { home: 3, away: 2, total: 5 }, wins: { home: 2, away: 1, total: 3 } } } },
      away: { id: 25, name: "Away Team", logo: "x", last_5: { played: 5, form: "60%", att: "55%", def: "50%", goals: { for: { total: 6, average: 1.2 }, against: { total: 6, average: 1.2 } } }, league: { form: "WLDWL", fixtures: { played: { home: 3, away: 2, total: 5 }, wins: { home: 1, away: 1, total: 2 } } } } },
    comparison: { form: { home: "55%", away: "45%" }, att: { home: "60%", away: "40%" }, def: { home: "52%", away: "48%" }, poisson_distribution: { home: "58%", away: "42%" }, h2h: { home: "50%", away: "50%" }, goals: { home: "56%", away: "44%" }, total: { home: "55%", away: "45%" } },
    h2h: Array.from({ length: 10 }, (_, i) => afFixture(i)) };
}
function saLineupRaw() {
  const player = (i: number) => ({ player_id: `pl_${i}`, name: `Player ${i}`, jersey_number: i, position: "MF", grid: "3:2", captain: i === 1, rating: null, is_starting: true, stats: null, photo: `https://cdn.thestatsapi.com/p/${i}.png` });
  const side = (p: string) => ({ team_id: `tm_${p}`, team_name: `${p} Team`, formation: "4-3-3", coach: { id: `co_${p}`, name: "Coach Name", nationality: "Country" }, starting_xi: Array.from({ length: 11 }, (_, i) => player(i + 1)), substitutes: Array.from({ length: 12 }, (_, i) => player(i + 12)) });
  return { match_id: "mt_401944555", confirmed: true, home: side("home"), away: side("away") };
}
function stakeOddsRaw() {
  const values = (n: number) => Array.from({ length: n }, (_, i) => ({ value: `V${i}`, odd: (1.5 + i * 0.1).toFixed(2) }));
  const bets = Array.from({ length: 160 }, (_, i) => ({ id: i, name: `Market ${i}`, values: values(8) }));
  bets[0] = { id: 1, name: "Match Winner", values: [{ value: "Home", odd: "2.05" }, { value: "Draw", odd: "3.50" }, { value: "Away", odd: "3.70" }] } as any;
  bets[1] = { id: 5, name: "Goals Over/Under", values: [{ value: "Over 2.5", odd: "2.00" }, { value: "Under 2.5", odd: "1.80" }] } as any;
  bets[2] = { id: 8, name: "Both Teams Score", values: [{ value: "Yes", odd: "1.90" }, { value: "No", odd: "1.90" }] } as any;
  return [{ fixture: { id: 1567308 }, bookmakers: [{ id: 90, name: "Stake", bets }] }];
}
function pinnacle9B() {
  return { matchId: "mt_401944555", bookmaker: "Bet365", is_pinnacle: false,
    markets: [{ market: "1X2 Full Time Result", outcomes: [{ name: "Home", opening: 2.1, current: 2.05, movement_pct: -2.38 }, { name: "Draw", opening: 3.4, current: 3.5, movement_pct: 2.94 }, { name: "Away", opening: 3.6, current: 3.7, movement_pct: 2.78 }] }],
    gap_check: [{ outcome: "Home", stake: 2.1, pinnacle: 2.05, verdict: "STAKE OFFERS VALUE" }], note: "Bet365 — pinnacle null." };
}
function refereeProfile() { return { referee: "Szymon Marciniak", matches_officiated: 42, avg_yellow_cards_per_game: 4.3, avg_red_cards_per_game: 0.18, avg_fouls_per_game: 26.1, penalties_per_game: 0.24 }; }
function cr(status: string, data: unknown): CallResult { return { key: "x", label: "x", status: status as CallResult["status"], data }; }

describe("token audit (trimmed)", () => {
  it("reports per-block token counts", () => {
    const results: Record<string, CallResult> = {
      "2A": cr("SUCCESS", saTeamStatsStored()), "2B": cr("SUCCESS", saTeamStatsStored()),
      "3": cr("SUCCESS", Array.from({ length: 10 }, (_, i) => afFixture(i))),
      "4-1": cr("SUCCESS", Array.from({ length: 5 }, (_, i) => afFixture(i))),
      "4-2": cr("SUCCESS", Array.from({ length: 5 }, (_, i) => afFixture(i))),
      "4-3": cr("SUCCESS", Array.from({ length: 10 }, (_, i) => afFixture(i))),
      "5": cr("SUCCESS", Array.from({ length: 8 }, (_, i) => afInjury(i))),
      "6": cr("SUCCESS", saLineupRaw()), "7": cr("SUCCESS", refereeProfile()),
      "8": cr("SUCCESS", [afPredictions()]), "9": cr("SUCCESS", { stakeOdds: stakeOddsRaw() }),
      "9B": cr("SUCCESS", pinnacle9B()), "10": cr("EMPTY", null),
    };
    const full = formatDataForClaude(results);
    const acc: Record<string, string> = {}; let current = "misc";
    for (const line of full.split("\n")) {
      const m = line.match(/^\[CALL ([0-9A-B]+) /); if (m) current = "CALL " + m[1];
      acc[current] = (acc[current] ?? "") + line + "\n";
    }
    const rows = Object.entries(acc).map(([k, v]) => ({ block: k, chars: v.length, tok: Math.round(v.length / 4) })).sort((a, b) => b.chars - a.chars);
    console.log("\n=== PER-BLOCK (TRIMMED) ===");
    for (const r of rows) console.log(`${r.block.padEnd(10)} chars=${String(r.chars).padStart(7)}  ~tokens=${String(r.tok).padStart(6)}`);
    console.log("\n=== TOTALS ===");
    console.log(`FORMATTED DATA   ~tokens=${Math.round(full.length / 4)}`);
    console.log(`SYSTEM PROMPT    ~tokens=${Math.round(SYSTEM_PROMPT.length / 4)}`);
    console.log(`GRAND TOTAL      ~tokens=${Math.round((full.length + SYSTEM_PROMPT.length) / 4)}`);
  });
});
