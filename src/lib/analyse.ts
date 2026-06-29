// Per-match data collection pipeline (Step 0 lookup + Step 1 sequential calls).
// Runs entirely client-side. Does NOT call Claude.

import type { AnalysedMatch } from "./fixtures";
import {
  getApiCallCount,
  incrementApiCallCount,
  WARNING_THRESHOLD,
} from "./apiCounter";

const AF_BASE = "https://v3.football.api-sports.io";
const SA_BASE = "https://api.thestatsapi.com/api/football";

export type CallStatus = "SUCCESS" | "EMPTY" | "FAILED" | "SKIPPED";

export interface CallResult {
  key: string;
  label: string;
  status: CallStatus;
  data?: unknown;
  error?: string;
}

export interface ProgressUpdate {
  step: number;
  total: number;
  label: string;
}

export interface CollectionResult {
  callResults: Record<string, CallResult>;
  statsApiResolved: boolean;
  statsApiMatchId: string | null;
  succeeded: number;
  emptyOrFailed: number;
  failedCalls: string[];
  warning: string | null;
  counterWarning: boolean;
}

// Maps internal call keys to the endpoint labels used in the Claude prompt.
// Keys mirror the order the system prompt expects (CALL 2A ... CALL 10).
const CLAUDE_CALL_ORDER: Array<{ key: string; n: string; endpoint: string }> = [
  { key: "2A", n: "2A", endpoint: "/teams/statistics (home)" },
  { key: "2B", n: "2B", endpoint: "/teams/statistics (away)" },
  { key: "3", n: "3", endpoint: "/fixtures/headtohead" },
  { key: "4-3", n: "4", endpoint: "/fixtures/statistics (batch)" },
  { key: "5", n: "5", endpoint: "/injuries" },
  { key: "6", n: "6", endpoint: "TheStatsAPI/lineups" },
  { key: "7", n: "7", endpoint: "/fixtures (referee history)" },
  { key: "8", n: "8", endpoint: "/predictions" },
  { key: "9A", n: "9A", endpoint: "/odds (Stake)" },
  { key: "9B", n: "9B", endpoint: "TheStatsAPI/odds (Pinnacle)" },
  { key: "10", n: "10", endpoint: "/fixtures (bracket)" },
];

/**
 * Formats the collected call results into the [CALL N ... END CALL N] blocks
 * that the v3.0 system prompt expects. Calls 9A/9B are split out of the
 * combined "9" result. Missing/empty/errored calls render as EMPTY blocks.
 */
export function formatDataForClaude(
  callResults: Record<string, CallResult>,
): string {
  // The combined odds step stores its data under key "9".
  const combinedOdds = callResults["9"];
  const oddsData = (combinedOdds?.data ?? null) as {
    stakeOdds?: unknown;
    pinnacleOdds?: unknown;
    pinnacleError?: string | null;
  } | null;

  const resolved: Record<string, { status: CallStatus; data: unknown; error?: string }> = {};
  for (const [k, v] of Object.entries(callResults)) {
    resolved[k] = { status: v.status, data: v.data ?? null, error: v.error };
  }
  // Synthesize 9A and 9B from the combined "9" call.
  if (combinedOdds) {
    const stake = oddsData?.stakeOdds ?? null;
    resolved["9A"] = {
      status: isEmptyResponse(stake) || combinedOdds.status !== "SUCCESS" ? "EMPTY" : "SUCCESS",
      data: stake,
    };
    const pinnacle = oddsData?.pinnacleOdds ?? null;
    resolved["9B"] = {
      status: isEmptyResponse(pinnacle) ? "EMPTY" : "SUCCESS",
      data: pinnacle,
      error: oddsData?.pinnacleError ?? undefined,
    };
  }

  const blocks: string[] = [];
  for (const { key, n, endpoint } of CLAUDE_CALL_ORDER) {
    const r = resolved[key];
    const hasData =
      r && r.status === "SUCCESS" && r.data !== null && !isEmptyResponse(r.data);
    if (hasData) {
      blocks.push(
        `[CALL ${n} — ${endpoint} — SUCCESS]\n${JSON.stringify(r.data, null, 2)}\n[END CALL ${n}]`,
      );
    } else {
      blocks.push(
        `[CALL ${n} — ${endpoint} — EMPTY]\nNo data available for this call.\n[END CALL ${n}]`,
      );
    }
  }
  return blocks.join("\n\n");
}

const TOTAL_STEPS = 11;

function normalize(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function pairKey(home: string, away: string): string {
  return `${normalize(home)}_vs_${normalize(away)}`;
}

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

// Deep-replace null values with "NOT_AVAILABLE".
function replaceNulls(value: unknown): unknown {
  if (value === null) return "NOT_AVAILABLE";
  if (Array.isArray(value)) return value.map(replaceNulls);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = replaceNulls(v);
    }
    return out;
  }
  return value;
}

interface AfResponse {
  errors?: unknown;
  response?: unknown;
}

function afErrors(errors: unknown): string | null {
  if (!errors) return null;
  if (Array.isArray(errors)) return errors.length ? errors.join(", ") : null;
  if (typeof errors === "object") {
    const vals = Object.values(errors as Record<string, unknown>);
    return vals.length ? vals.map(String).join(", ") : null;
  }
  if (typeof errors === "string") return errors.trim() ? errors : null;
  return null;
}

// API-Football GET. Increments the daily counter on a successful HTTP response.
async function afGet(path: string, key: string): Promise<unknown> {
  const res = await fetch(`${AF_BASE}${path}`, {
    headers: { "x-apisports-key": key },
  });
  if (!res.ok) {
    throw new Error(`API-Football ${res.status} ${res.statusText}`);
  }
  incrementApiCallCount();
  const json = (await res.json()) as AfResponse;
  const err = afErrors(json.errors);
  if (err) throw new Error(err);
  return json.response ?? null;
}

function isEmptyResponse(response: unknown): boolean {
  if (response === null || response === undefined) return true;
  if (Array.isArray(response)) return response.length === 0;
  if (typeof response === "object")
    return Object.keys(response as object).length === 0;
  return false;
}

async function saGet(path: string, key: string): Promise<unknown> {
  const res = await fetch(`${SA_BASE}${path}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) {
    throw new Error(`TheStatsAPI ${res.status} ${res.statusText}`);
  }
  return res.json();
}

// Pull an array out of common TheStatsAPI envelope shapes.
function extractArray(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    for (const field of ["data", "matches", "competitions", "results"]) {
      if (Array.isArray(obj[field])) return obj[field] as unknown[];
    }
  }
  return [];
}

function getField(obj: unknown, keys: string[]): unknown {
  if (!obj || typeof obj !== "object") return undefined;
  const rec = obj as Record<string, unknown>;
  for (const k of keys) {
    if (rec[k] !== undefined && rec[k] !== null) return rec[k];
  }
  return undefined;
}

function getTeamName(obj: unknown, side: "home" | "away"): string | null {
  const rec = obj as Record<string, unknown>;
  if (!rec) return null;
  const direct = getField(obj, [`${side}_team_name`, `${side}_name`]);
  if (typeof direct === "string") return direct;
  const team = getField(obj, [`${side}_team`, side]);
  if (team && typeof team === "object") {
    const n = getField(team, ["name", "team_name", "title"]);
    if (typeof n === "string") return n;
  }
  return null;
}

interface WcIds {
  competitionId: string;
  seasonId: string;
}

async function resolveWcIds(key: string): Promise<WcIds | null> {
  const cacheKey = `statsapi_wc2026_ids_${todayDate()}`;
  if (typeof window !== "undefined") {
    const cached = window.localStorage.getItem(cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached) as WcIds;
      } catch {
        // fall through and re-fetch
      }
    }
  }

  const payload = await saGet("/competitions", key);
  const comps = extractArray(payload);
  const wc = comps.find((c) => {
    const name = getField(c, ["name", "title", "competition_name"]);
    return typeof name === "string" && normalize(name).includes("fifa world cup 2026");
  });
  if (!wc) return null;

  const competitionId = getField(wc, ["competition_id", "id"]);
  let seasonId = getField(wc, ["season_id", "current_season_id"]);
  if (!seasonId) {
    const season = getField(wc, ["current_season", "season"]);
    seasonId = getField(season, ["season_id", "id"]);
  }
  if (!competitionId || !seasonId) return null;

  const ids: WcIds = {
    competitionId: String(competitionId),
    seasonId: String(seasonId),
  };
  if (typeof window !== "undefined") {
    window.localStorage.setItem(cacheKey, JSON.stringify(ids));
  }
  return ids;
}

// Step 0: build name -> statsapi match id lookup for today + tomorrow.
async function buildStatsApiLookup(
  key: string,
): Promise<Record<string, string>> {
  const ids = await resolveWcIds(key);
  if (!ids) return {};

  const lookup: Record<string, string> = {};
  const today = todayDate();
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

  for (const date of [today, tomorrow]) {
    const payload = await saGet(
      `/matches?competition_id=${encodeURIComponent(
        ids.competitionId,
      )}&season_id=${encodeURIComponent(ids.seasonId)}&date=${date}`,
      key,
    );
    for (const m of extractArray(payload)) {
      const home = getTeamName(m, "home");
      const away = getTeamName(m, "away");
      const matchId = getField(m, ["match_id", "id"]);
      if (home && away && matchId !== undefined) {
        lookup[pairKey(home, away)] = String(matchId);
      }
    }
  }
  return lookup;
}

function nextRound(current: string | null): string | null {
  if (!current) return null;
  const c = current.toLowerCase();
  if (c.includes("round of 32")) return "Round of 16";
  if (c.includes("round of 16")) return "Quarter-finals";
  if (c.includes("quarter")) return "Semi-finals";
  if (c.includes("semi")) return "Finals";
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function collectMatchData(
  match: AnalysedMatch,
  onProgress: (p: ProgressUpdate) => void,
): Promise<CollectionResult> {
  const afKey = import.meta.env.VITE_APIFOOTBALL_KEY as string | undefined;
  const saKey = import.meta.env.VITE_STATSAPI_KEY as string | undefined;
  if (!afKey) throw new Error("Missing VITE_APIFOOTBALL_KEY.");

  const callResults: Record<string, CallResult> = {};
  const stepKeys: string[] = [];

  const record = (
    key: string,
    label: string,
    status: CallStatus,
    data?: unknown,
    error?: string,
  ) => {
    const validated = data !== undefined ? replaceNulls(data) : undefined;
    callResults[key] = { key, label, status, data: validated, error };
    console.log(`[analyse] ${key} (${label}): ${status}`, error ?? "");
  };

  // ---- STEP 0: TheStatsAPI lookup ----
  let lookup: Record<string, string> = {};
  let statsApiResolved = false;
  let statsApiMatchId: string | null = null;
  if (saKey) {
    try {
      lookup = await buildStatsApiLookup(saKey);
      statsApiMatchId = lookup[pairKey(match.home, match.away)] ?? null;
      statsApiResolved = statsApiMatchId !== null;
    } catch (e) {
      console.warn("[analyse] StatsAPI lookup failed", e);
    }
  }

  // Wrapper that runs one numbered step and records its result.
  const runStep = async (
    key: string,
    label: string,
    fn: () => Promise<unknown>,
    opts: { skip?: boolean; skipReason?: string } = {},
  ) => {
    stepKeys.push(key);
    const step = stepKeys.length;
    onProgress({ step, total: TOTAL_STEPS, label });
    if (opts.skip) {
      record(key, label, "SKIPPED", undefined, opts.skipReason);
      return;
    }
    try {
      const response = await fn();
      record(key, label, isEmptyResponse(response) ? "EMPTY" : "SUCCESS", response);
    } catch (e) {
      record(key, label, "FAILED", undefined, e instanceof Error ? e.message : String(e));
    }
  };

  const counterWarning = getApiCallCount() >= WARNING_THRESHOLD;

  // ---- STEP 1: data calls ----
  // 1 + 2: team statistics
  await runStep("2A", "Fetching home team statistics... (1/11)", async () => {
    const r = await afGet(
      `/teams/statistics?league=1&season=2026&team=${match.homeId}`,
      afKey,
    );
    const avg = getField(getField(getField(r, ["goals"]), ["for"]), ["average"]);
    if (!avg || getField(avg, ["total"]) === undefined) {
      console.warn("[analyse] 2A missing goals.for.average.total");
    }
    return r;
  });
  await runStep("2B", "Fetching away team statistics... (2/11)", async () => {
    const r = await afGet(
      `/teams/statistics?league=1&season=2026&team=${match.awayId}`,
      afKey,
    );
    const avg = getField(getField(getField(r, ["goals"]), ["for"]), ["average"]);
    if (!avg || getField(avg, ["total"]) === undefined) {
      console.warn("[analyse] 2B missing goals.for.average.total");
    }
    return r;
  });

  // 3: head-to-head
  await runStep("3", "Fetching head-to-head data... (3/11)", () =>
    afGet(`/fixtures/headtohead?h2h=${match.homeId}-${match.awayId}&last=10`, afKey),
  );

  // 4 step 1: home recent form
  let homeFixtureIds: number[] = [];
  await runStep("4-1", "Fetching recent form step 1... (4/11)", async () => {
    const r = await afGet(
      `/fixtures?team=${match.homeId}&last=5&league=1&season=2026`,
      afKey,
    );
    homeFixtureIds = extractArray(r)
      .map((f) => getField(getField(f, ["fixture"]), ["id"]))
      .filter((id): id is number => typeof id === "number");
    return r;
  });

  // 4 step 2: away recent form
  let awayFixtureIds: number[] = [];
  await runStep("4-2", "Fetching recent form step 2... (5/11)", async () => {
    const r = await afGet(
      `/fixtures?team=${match.awayId}&last=5&league=1&season=2026`,
      afKey,
    );
    awayFixtureIds = extractArray(r)
      .map((f) => getField(getField(f, ["fixture"]), ["id"]))
      .filter((id): id is number => typeof id === "number");
    return r;
  });

  // 4 step 3: combined batch
  await runStep("4-3", "Fetching recent form batch... (6/11)", () => {
    const ids = Array.from(new Set([...homeFixtureIds, ...awayFixtureIds])).slice(0, 10);
    if (ids.length === 0) return Promise.resolve(null);
    return afGet(`/fixtures?ids=${ids.join("-")}`, afKey);
  });

  // 5: injuries
  await runStep("5", "Fetching injuries... (7/11)", () =>
    afGet(`/injuries?fixture=${match.id}`, afKey),
  );

  // 6: confirmed lineups (TheStatsAPI, with retries)
  await runStep(
    "6",
    "Fetching confirmed lineups... (8/11)",
    async () => {
      if (!statsApiMatchId) throw new Error("StatsAPI match id unavailable");
      for (let attempt = 0; attempt < 3; attempt++) {
        const payload = await saGet(
          `/matches/${encodeURIComponent(statsApiMatchId)}/lineups`,
          saKey!,
        );
        if (!isEmptyResponse(extractArray(payload)) || !isEmptyResponse(payload)) {
          return payload;
        }
        if (attempt < 2) await sleep(5000);
      }
      throw new Error("LINEUP PENDING — not yet published");
    },
    {
      skip: !statsApiResolved,
      skipReason:
        "TheStatsAPI match ID not resolved — lineups unavailable.",
    },
  );

  // 7: referee profile
  await runStep(
    "7",
    "Fetching referee profile... (9/11)",
    () =>
      afGet(
        `/fixtures?referee=${encodeURIComponent(match.referee!)}&season=2026`,
        afKey,
      ),
    {
      skip: !match.referee,
      skipReason: "No referee assigned in fixture data.",
    },
  );

  // 8: predictions (skipped if near daily cap)
  await runStep(
    "8",
    "Fetching predictions... (10/11)",
    () => afGet(`/predictions?fixture=${match.id}`, afKey),
    {
      skip: counterWarning,
      skipReason: "Skipped — daily API budget near limit (>=85).",
    },
  );

  // 9: odds + Pinnacle
  await runStep("9", "Fetching odds and Pinnacle data... (11/11)", async () => {
    // 9A: resolve Stake bookmaker id (cached)
    let stakeId: string | null =
      typeof window !== "undefined"
        ? window.localStorage.getItem("stake_bookmaker_id")
        : null;
    if (!stakeId) {
      const bookmakers = await afGet(`/odds/bookmakers`, afKey);
      const stake = extractArray(bookmakers).find((b) => {
        const name = getField(b, ["name"]);
        return typeof name === "string" && normalize(name).includes("stake");
      });
      const id = getField(stake, ["id"]);
      if (id !== undefined) {
        stakeId = String(id);
        if (typeof window !== "undefined")
          window.localStorage.setItem("stake_bookmaker_id", stakeId);
      }
    }
    const afOdds = await afGet(
      `/odds?fixture=${match.id}${stakeId ? `&bookmaker=${stakeId}` : ""}`,
      afKey,
    );

    // 9B: TheStatsAPI odds (Pinnacle)
    let saOdds: unknown = null;
    let saOddsError: string | null = null;
    if (statsApiResolved && statsApiMatchId) {
      try {
        saOdds = await saGet(
          `/matches/${encodeURIComponent(statsApiMatchId)}/odds`,
          saKey!,
        );
      } catch (e) {
        saOddsError = e instanceof Error ? e.message : String(e);
      }
    } else {
      saOddsError = "TheStatsAPI match ID not resolved — Pinnacle odds unavailable.";
    }
    return { stakeOdds: afOdds, pinnacleOdds: saOdds, pinnacleError: saOddsError };
  });

  // CALL 10: next-round bracket (extra; not part of the 11 progress steps)
  const nr = nextRound(match.round);
  if (counterWarning) {
    record("10", "Next-round bracket", "SKIPPED", undefined,
      "Skipped — daily API budget near limit (>=85).");
  } else if (!nr) {
    record("10", "Next-round bracket", "SKIPPED", undefined,
      "Could not derive next round from current round.");
  } else {
    try {
      const r = await afGet(
        `/fixtures?league=1&season=2026&round=${encodeURIComponent(nr)}`,
        afKey,
      );
      record("10", "Next-round bracket", isEmptyResponse(r) ? "EMPTY" : "SUCCESS", r);
    } catch (e) {
      record("10", "Next-round bracket", "FAILED", undefined,
        e instanceof Error ? e.message : String(e));
    }
  }

  // ---- Summary over the 11 progress steps ----
  const succeeded = stepKeys.filter(
    (k) => callResults[k]?.status === "SUCCESS",
  ).length;
  const failedCalls = stepKeys.filter(
    (k) => callResults[k] && callResults[k].status !== "SUCCESS",
  );
  const emptyOrFailed = failedCalls.length;

  return {
    callResults,
    statsApiResolved,
    statsApiMatchId,
    succeeded,
    emptyOrFailed,
    failedCalls,
    warning: statsApiResolved
      ? null
      : "⚠️ TheStatsAPI match ID not resolved. Lineups and Pinnacle odds unavailable. Analysis will proceed with reduced data.",
    counterWarning,
  };
}

// ============================================================================
// TEST MODE — France vs Senegal mock data
// Mirrors the few-shot example injected data from the v3.0 system prompt so the
// full Claude pipeline (formatDataForClaude -> server fn -> JSON parse -> render)
// can be exercised without any live API calls.
// ============================================================================

export const MOCK_TEST_MATCH: AnalysedMatch = {
  id: 998234,
  home: "France",
  away: "Senegal",
  homeId: 2,
  awayId: 47,
  kickoffUtc: "2026-07-01T21:00:00Z",
  isTomorrow: false,
  referee: "Felix Zwayer",
  round: "Round of 32",
  venueName: "MetLife Stadium",
  venueCity: "East Rutherford, NJ",
  minutesUntilKickoff: 80,
  status: "OPTIMAL",
};

// callResults keyed exactly as collectMatchData produces them. formatDataForClaude
// synthesizes 9A/9B from the combined "9" entry, so mock odds live under key "9".
export function buildMockCollectionResult(): CollectionResult {
  const mk = (
    key: string,
    label: string,
    data: unknown,
  ): CallResult => ({ key, label, status: "SUCCESS", data });

  const callResults: Record<string, CallResult> = {
    "2A": mk("2A", "Fetching home team statistics... (1/11)", {
      team: "France",
      form: "WWWDW",
      goals_scored_avg: 2.1,
      goals_conceded_avg: 0.6,
      clean_sheets: "3 of 5",
      xG_proxy_avg: 2.2,
      possession_avg: "62%",
      corners_avg: 6.8,
      yellows_avg: 1.8,
      failed_to_score: "0 of 5",
    }),
    "2B": mk("2B", "Fetching away team statistics... (2/11)", {
      team: "Senegal",
      form: "WLDWW",
      goals_scored_avg: 1.2,
      goals_conceded_avg: 1.0,
      clean_sheets: "1 of 5",
      xG_proxy_avg: 1.1,
      possession_avg: "44%",
      corners_avg: 4.1,
      yellows_avg: 2.6,
      failed_to_score: "1 of 5",
    }),
    "3": mk("3", "Fetching head-to-head data... (3/11)", {
      meetings: "Last 5 competitive: 3 matches",
      france_won: 2,
      senegal_won: 1,
      goals_per_game: 2.33,
      btts: "2 of 3 = 67%",
    }),
    "4-1": mk("4-1", "Fetching recent form step 1... (4/11)", {
      team: "France",
      note: "home recent form fixtures",
    }),
    "4-2": mk("4-2", "Fetching recent form step 2... (5/11)", {
      team: "Senegal",
      note: "away recent form fixtures",
    }),
    "4-3": mk("4-3", "Fetching recent form batch... (6/11)", {
      France_last_5: {
        shots_on_target: [7, 6, 8, 5, 7],
        shots_on_target_avg: 6.6,
        corners: [7, 8, 6, 7, 8],
        corners_avg: 7.2,
        yellows: [2, 1, 2, 1, 3],
        yellows_avg: 1.8,
        fouls: [11, 10, 12, 9, 11],
        fouls_avg: 10.6,
      },
      Senegal_last_5: {
        shots_on_target: [4, 3, 5, 3, 4],
        shots_on_target_avg: 3.8,
        corners: [4, 3, 5, 4, 4],
        corners_avg: 4.0,
        yellows: [3, 2, 3, 3, 2],
        yellows_avg: 2.6,
        fouls: [14, 13, 15, 12, 14],
        fouls_avg: 13.6,
      },
    }),
    "5": mk("5", "Fetching injuries... (7/11)", {
      Senegal: [{ player: "Sadio Mane", status: "DOUBTFUL", reason: "hamstring" }],
      France: "no absences",
    }),
    "6": mk("6", "Fetching confirmed lineups... (8/11)", {
      France: {
        formation: "4-3-3",
        starters: [
          "Maignan", "Pavard", "Upamecano", "Saliba", "Hernandez",
          "Tchouameni", "Camavinga", "Rabiot", "Dembele", "Giroud", "Mbappe",
        ],
        bench: "15 listed",
      },
      Senegal: {
        formation: "4-4-2",
        mane: "NOT in starting 11 — confirmed absent",
        replacement: "Dia starting",
      },
    }),
    "7": mk("7", "Fetching referee profile... (9/11)", {
      referee: "Felix Zwayer",
      matches_officiated: 4,
      avg_yellows: 3.8,
      avg_fouls: 24.1,
      penalties_awarded: "1 in 4 games",
      strictness: 89.95,
      result: "HIGH strictness (above 50)",
    }),
    "8": mk("8", "Fetching predictions... (10/11)", {
      france_win: "68%",
      draw: "19%",
      senegal_win: "13%",
      goals_line: "Over 2.5",
      poisson_goals_estimate: 2.3,
    }),
    "9": mk("9", "Fetching odds and Pinnacle data... (11/11)", {
      stakeOdds: {
        "1X2": { France: 1.72, Draw: 3.8, Senegal: 5.5 },
        asian_handicap_france_minus1: 2.1,
        over_2_5: 2.05,
        under_2_5: 1.78,
        btts_yes: 1.9,
        btts_no: 1.85,
        corners_over_9_5: 1.88,
        corners_under_9_5: 1.92,
        cards_over_3_5: 1.82,
        cards_under_3_5: 1.98,
      },
      pinnacleOdds: {
        france_1x2: { opening: 1.68, current: 1.65 },
        draw: { opening: 3.9, current: 4.05 },
        senegal: { opening: 5.8, current: 5.9 },
        over_2_5: { opening: 1.98, current: 2.1 },
        under_2_5: { opening: 1.83, current: 1.72 },
        btts_yes: { opening: 1.85, current: 1.88 },
        corners_over_9_5: { opening: 1.91, current: 1.94 },
        cards_over_3_5: { opening: 1.75, current: 1.78 },
      },
      pinnacleError: null,
    }),
    "10": mk("10", "Next-round bracket", {
      next_round: "Round of 16",
      opponent: "Winner faces England vs Congo DR winner",
      rotation_motivation: "none detected",
    }),
  };

  const stepKeys = [
    "2A", "2B", "3", "4-1", "4-2", "4-3", "5", "6", "7", "8", "9",
  ];
  const succeeded = stepKeys.filter(
    (k) => callResults[k]?.status === "SUCCESS",
  ).length;
  const failedCalls = stepKeys.filter(
    (k) => callResults[k] && callResults[k].status !== "SUCCESS",
  );

  return {
    callResults,
    statsApiResolved: true,
    statsApiMatchId: "mock-998234",
    succeeded,
    emptyOrFailed: failedCalls.length,
    failedCalls,
    warning: null,
    counterWarning: false,
  };
}
