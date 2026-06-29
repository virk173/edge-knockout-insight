// Per-match data collection pipeline (Step 0 lookup + Step 1 sequential calls).
// Runs entirely client-side. Does NOT call Claude.

import { computeStatus, type AnalysedMatch } from "./fixtures";
import { apiFetch } from "./api-proxy.functions";
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

// A single raw HTTP call captured during a debug run.
export interface DebugEntry {
  api: "API-Football" | "TheStatsAPI";
  url: string;
  status: number | string;
  ok: boolean;
  json: unknown;
  error?: string;
  callLabel?: string;
}

// One logical call row for the structured Debug Mode report.
export interface DebugCallRow {
  callLabel: string; // e.g. "CALL 2A"
  api: "API-Football" | "TheStatsAPI";
  endpoint: string;
  url: string;
  status: number | string;
  ok: boolean;
  dataExtracted: boolean;
  json: unknown;
  error?: string;
}

export interface DebugReport {
  competitionId: string | null;
  seasonId: string | null;
  statsMatchId: string | null;
  rows: DebugCallRow[];
  afSucceeded: number;
  afTotal: number;
  saSucceeded: number;
  saTotal: number;
  readyForClaude: boolean;
}

export interface CollectionResult {
  callResults: Record<string, CallResult>;
  statsApiResolved: boolean;
  statsApiMatchId: string | null;
  wcCompetitionId: string | null;
  wcSeasonId: string | null;
  succeeded: number;
  emptyOrFailed: number;
  failedCalls: string[];
  warning: string | null;
  counterWarning: boolean;
  debugEntries?: DebugEntry[];
}

// Module-level sink. When non-null, afGet/saGet record every raw HTTP call
// (url, status, parsed JSON) into it. collectMatchData wires this up for the
// duration of a single debug run, since the pipeline runs sequentially.
let debugSink: DebugEntry[] | null = null;

// Module-level label for the logical call currently executing. afGet/saGet
// stamp every captured DebugEntry with it so the Debug report can group raw
// HTTP calls under their logical CALL number (e.g. "2A", "9B", "competitions").
let currentDebugCall: string | null = null;

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
  callResults: Record<string, CallResult> | null | undefined,
): string {
  // Defensive: never assume callResults (or any individual entry) exists.
  const safeResults: Record<string, CallResult> = callResults ?? {};

  // Safely pull the validated data out of a single call result.
  const getCallData = (key: string): unknown => {
    const result = safeResults[key];
    if (!result || result.status !== "SUCCESS" || result.data == null) {
      return null;
    }
    return result.data;
  };

  // The combined odds step stores its data under key "9".
  const combinedOdds = safeResults["9"];
  const oddsData = (getCallData("9") ?? null) as {
    stakeOdds?: unknown;
    pinnacleOdds?: unknown;
    pinnacleError?: string | null;
  } | null;

  const resolved: Record<string, { status: CallStatus; data: unknown; error?: string }> = {};
  for (const [k, v] of Object.entries(safeResults)) {
    if (!v) continue;
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

// Treats "NOT_AVAILABLE" (our null sentinel), null, empty arrays/objects as no data.
function hasUsableData(x: unknown): boolean {
  if (x === null || x === undefined || x === "NOT_AVAILABLE") return false;
  if (Array.isArray(x)) return x.length > 0;
  if (typeof x === "object") return Object.keys(x as object).length > 0;
  return true;
}

/**
 * Builds the structured Debug Mode report: one row per logical API call with
 * its URL, HTTP status, raw JSON, and whether formatDataForClaude would extract
 * data from it, plus per-API success tallies and a Claude-readiness flag.
 */
export function buildDebugReport(result: CollectionResult): DebugReport {
  const entries = result.debugEntries ?? [];
  const cr = result.callResults;

  const findEntry = (label: string): DebugEntry | undefined => {
    const matches = entries.filter((e) => e.callLabel === label);
    return matches.length ? matches[matches.length - 1] : undefined;
  };

  const odds = cr["9"]?.data as
    | { stakeOdds?: unknown; pinnacleOdds?: unknown }
    | undefined;

  interface Spec {
    callLabel: string;
    api: "API-Football" | "TheStatsAPI";
    endpoint: string;
    entryKey: string;
    crKey?: string;
    extracted: boolean;
    count: boolean;
  }

  const specs: Spec[] = [
    { callLabel: "CALL 2A", api: "API-Football", endpoint: "/teams/statistics (South Africa)", entryKey: "2A", extracted: cr["2A"]?.status === "SUCCESS", count: true },
    { callLabel: "CALL 2B", api: "API-Football", endpoint: "/teams/statistics (Canada)", entryKey: "2B", extracted: cr["2B"]?.status === "SUCCESS", count: true },
    { callLabel: "CALL 3", api: "API-Football", endpoint: "/fixtures/headtohead", entryKey: "3", extracted: cr["3"]?.status === "SUCCESS", count: true },
    { callLabel: "CALL 4", api: "API-Football", endpoint: "/fixtures (last 5 each team)", entryKey: "4", crKey: "4-3", extracted: cr["4-3"]?.status === "SUCCESS", count: true },
    { callLabel: "CALL 5", api: "API-Football", endpoint: "/injuries", entryKey: "5", extracted: cr["5"]?.status === "SUCCESS", count: true },
    { callLabel: "CALL 7", api: "API-Football", endpoint: "/fixtures (referee history)", entryKey: "7", extracted: cr["7"]?.status === "SUCCESS", count: true },
    { callLabel: "CALL 8", api: "API-Football", endpoint: "/predictions", entryKey: "8", extracted: cr["8"]?.status === "SUCCESS", count: true },
    { callLabel: "CALL 9A", api: "API-Football", endpoint: "/odds (Stake)", entryKey: "9A", extracted: hasUsableData(odds?.stakeOdds), count: true },
    { callLabel: "STATSAPI competitions", api: "TheStatsAPI", endpoint: "/football/competitions (verify IDs)", entryKey: "competitions", extracted: result.wcCompetitionId !== null, count: false },
    { callLabel: "STATSAPI matches", api: "TheStatsAPI", endpoint: "/football/matches (match ID lookup)", entryKey: "matches", extracted: result.statsApiMatchId !== null, count: true },
    { callLabel: "CALL 6", api: "TheStatsAPI", endpoint: "/matches/{id}/lineups", entryKey: "6", extracted: cr["6"]?.status === "SUCCESS", count: true },
    { callLabel: "CALL 9B", api: "TheStatsAPI", endpoint: "/matches/{id}/odds (Pinnacle)", entryKey: "9B", extracted: hasUsableData(odds?.pinnacleOdds), count: true },
  ];

  const rows: DebugCallRow[] = specs.map((sp) => {
    const entry = findEntry(sp.entryKey);
    const crEntry = cr[sp.crKey ?? sp.entryKey];
    return {
      callLabel: sp.callLabel,
      api: sp.api,
      endpoint: sp.endpoint,
      url: entry?.url ?? "— (not called)",
      status: entry?.status ?? crEntry?.status ?? "NOT CALLED",
      ok: entry?.ok ?? false,
      dataExtracted: sp.extracted,
      json: entry?.json ?? crEntry?.data ?? null,
      error: entry?.error ?? crEntry?.error,
    };
  });

  const afCount = specs.filter((s) => s.api === "API-Football" && s.count);
  const saCount = specs.filter((s) => s.api === "TheStatsAPI" && s.count);
  const afSucceeded = afCount.filter((s) => s.extracted).length;
  const saSucceeded = saCount.filter((s) => s.extracted).length;

  return {
    competitionId: result.wcCompetitionId,
    seasonId: result.wcSeasonId,
    statsMatchId: result.statsApiMatchId,
    rows,
    afSucceeded,
    afTotal: afCount.length,
    saSucceeded,
    saTotal: saCount.length,
    readyForClaude:
      afSucceeded === afCount.length && saSucceeded === saCount.length,
  };
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

// API-Football GET (via server proxy). Increments the daily counter on a
// successful HTTP response. The `_key` arg is retained for call-site
// compatibility but is unused — the key lives server-side.
async function afGet(path: string, _key?: string): Promise<unknown> {
  const url = `${AF_BASE}${path}`;
  let result: { ok: boolean; status: number | string; statusText?: string; json: unknown };
  try {
    result = await apiFetch({ data: { provider: "apifootball", url } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    debugSink?.push({ api: "API-Football", url, status: "network error", ok: false, json: null, error: msg, callLabel: currentDebugCall ?? undefined });
    throw new Error(`API-Football network error: ${msg}`);
  }
  if (!result || !result.ok) {
    const status = result?.status ?? "no response";
    debugSink?.push({ api: "API-Football", url, status, ok: false, json: null, error: result?.statusText, callLabel: currentDebugCall ?? undefined });
    throw new Error(`API-Football ${status} ${result?.statusText ?? ""}`.trim());
  }
  incrementApiCallCount();
  const json = (result.json ?? null) as AfResponse | null;
  debugSink?.push({ api: "API-Football", url, status: result.status, ok: true, json, callLabel: currentDebugCall ?? undefined });
  const err = afErrors(json?.errors);
  if (err) throw new Error(err);
  return json?.response ?? null;
}

function isEmptyResponse(response: unknown): boolean {
  if (response === null || response === undefined) return true;
  if (Array.isArray(response)) return response.length === 0;
  if (typeof response === "object")
    return Object.keys(response as object).length === 0;
  return false;
}

async function saGet(path: string, _key?: string): Promise<unknown> {
  const url = `${SA_BASE}${path}`;
  let result: { ok: boolean; status: number | string; statusText?: string; json: unknown };
  try {
    result = await apiFetch({ data: { provider: "statsapi", url } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    debugSink?.push({ api: "TheStatsAPI", url, status: "network error", ok: false, json: null, error: msg, callLabel: currentDebugCall ?? undefined });
    throw new Error(`TheStatsAPI network error: ${msg}`);
  }
  if (!result || !result.ok) {
    const status = result?.status ?? "no response";
    debugSink?.push({ api: "TheStatsAPI", url, status, ok: false, json: null, error: result?.statusText, callLabel: currentDebugCall ?? undefined });
    throw new Error(`TheStatsAPI ${status} ${result?.statusText ?? ""}`.trim());
  }
  const json = result.json ?? null;
  debugSink?.push({ api: "TheStatsAPI", url, status: result.status, ok: true, json, callLabel: currentDebugCall ?? undefined });
  return json;
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

async function resolveWcIds(
  key: string,
  bypassCache = false,
): Promise<WcIds | null> {
  const cacheKey = `statsapi_wc2026_ids_${todayDate()}`;
  if (!bypassCache && typeof window !== "undefined") {
    const cached = window.localStorage.getItem(cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached) as WcIds;
      } catch {
        // fall through and re-fetch
      }
    }
  }

  const prev = currentDebugCall;
  currentDebugCall = "competitions";
  let payload: unknown;
  try {
    payload = await saGet("/competitions", key);
  } finally {
    currentDebugCall = prev;
  }
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

// Step 0: build name -> statsapi match id lookup. Returns the resolved
// competition/season ids alongside the lookup so the debug report can show them.
async function buildStatsApiLookup(
  key: string,
  opts: { dates?: string[]; bypassCache?: boolean } = {},
): Promise<{ lookup: Record<string, string>; ids: WcIds | null }> {
  const ids = await resolveWcIds(key, opts.bypassCache);
  if (!ids) return { lookup: {}, ids: null };

  const lookup: Record<string, string> = {};
  const today = todayDate();
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const dates = Array.from(new Set([today, tomorrow, ...(opts.dates ?? [])]));

  const prev = currentDebugCall;
  currentDebugCall = "matches";
  try {
    for (const date of dates) {
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
  } finally {
    currentDebugCall = prev;
  }
  return { lookup, ids };
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
  opts: { debug?: boolean } = {},
): Promise<CollectionResult> {
  // API keys live server-side (APIFOOTBALL_KEY / STATSAPI_KEY) and are used
  // by the api-proxy server function. These placeholders keep the existing
  // call-site signatures unchanged.
  const afKey = "";
  const saKey = "";

  // When debugging, capture every raw HTTP call made by afGet/saGet.
  const localDebug: DebugEntry[] = [];
  debugSink = opts.debug ? localDebug : null;

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
  let wcCompetitionId: string | null = null;
  let wcSeasonId: string | null = null;
  try {
    const matchDate = match.kickoffUtc.slice(0, 10);
    const out = await buildStatsApiLookup(saKey, {
      dates: [matchDate],
      bypassCache: opts.debug,
    });
    lookup = out.lookup;
    wcCompetitionId = out.ids?.competitionId ?? null;
    wcSeasonId = out.ids?.seasonId ?? null;
    statsApiMatchId = lookup[pairKey(match.home, match.away)] ?? null;
    statsApiResolved = statsApiMatchId !== null;
  } catch (e) {
    console.warn("[analyse] StatsAPI lookup failed", e);
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
    currentDebugCall = key.startsWith("4") ? "4" : key;
    try {
      const response = await fn();
      record(key, label, isEmptyResponse(response) ? "EMPTY" : "SUCCESS", response);
    } catch (e) {
      record(key, label, "FAILED", undefined, e instanceof Error ? e.message : String(e));
    } finally {
      currentDebugCall = null;
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
    currentDebugCall = "9A";
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
    currentDebugCall = "9B";
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
    currentDebugCall = "10";
    try {
      const r = await afGet(
        `/fixtures?league=1&season=2026&round=${encodeURIComponent(nr)}`,
        afKey,
      );
      record("10", "Next-round bracket", isEmptyResponse(r) ? "EMPTY" : "SUCCESS", r);
    } catch (e) {
      record("10", "Next-round bracket", "FAILED", undefined,
        e instanceof Error ? e.message : String(e));
    } finally {
      currentDebugCall = null;
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

  // Detach the debug sink so later non-debug runs are not recorded into it.
  debugSink = null;

  return {
    callResults,
    statsApiResolved,
    statsApiMatchId,
    wcCompetitionId,
    wcSeasonId,
    succeeded,
    emptyOrFailed,
    failedCalls,
    warning: statsApiResolved
      ? null
      : "⚠️ TheStatsAPI match ID not resolved. Lineups and Pinnacle odds unavailable. Analysis will proceed with reduced data.",
    counterWarning,
    debugEntries: opts.debug ? localDebug : undefined,
  };
}


// ============================================================================
// DEBUG MODE — resolve a fixed real fixture for testing the full pipeline.
// South Africa vs Canada (2026-06-28). Fetches the real fixture from
// API-Football for that date so collectMatchData can run against live data.
// ============================================================================

export const DEBUG_FIXTURE_DATE = "2026-06-28";
const DEBUG_TEAM_A = "south africa";
const DEBUG_TEAM_B = "canada";

interface AfFixtureItem {
  fixture?: {
    id?: number;
    date?: string;
    referee?: string | null;
    venue?: { name?: string | null; city?: string | null } | null;
  };
  league?: { round?: string | null };
  teams?: {
    home?: { id?: number; name?: string };
    away?: { id?: number; name?: string };
  };
}

export async function resolveDebugFixture(): Promise<AnalysedMatch> {
  const afKey = import.meta.env.VITE_APIFOOTBALL_KEY as string | undefined;
  if (!afKey) throw new Error("Missing VITE_APIFOOTBALL_KEY.");

  const response = await afGet(
    `/fixtures?league=1&season=2026&date=${DEBUG_FIXTURE_DATE}`,
    afKey,
  );
  const items = extractArray(response) as AfFixtureItem[];

  const matches = (a: string, b: string) => {
    const x = normalize(a);
    const y = normalize(b);
    return (
      (x.includes(DEBUG_TEAM_A) && y.includes(DEBUG_TEAM_B)) ||
      (x.includes(DEBUG_TEAM_B) && y.includes(DEBUG_TEAM_A))
    );
  };

  const item = items.find((it) =>
    matches(it.teams?.home?.name ?? "", it.teams?.away?.name ?? ""),
  );

  if (!item || !item.fixture?.id || !item.teams?.home?.id || !item.teams?.away?.id) {
    throw new Error(
      `Debug fixture "South Africa vs Canada" not found in API-Football for ${DEBUG_FIXTURE_DATE}.`,
    );
  }

  const kickoffUtc = item.fixture.date ?? `${DEBUG_FIXTURE_DATE}T00:00:00Z`;
  const minutesUntilKickoff = Math.round(
    (new Date(kickoffUtc).getTime() - Date.now()) / 60000,
  );

  return {
    id: item.fixture.id,
    home: item.teams.home.name ?? "South Africa",
    away: item.teams.away.name ?? "Canada",
    homeId: item.teams.home.id,
    awayId: item.teams.away.id,
    kickoffUtc,
    isTomorrow: false,
    referee: item.fixture.referee ?? null,
    round: item.league?.round ?? null,
    venueName: item.fixture.venue?.name ?? null,
    venueCity: item.fixture.venue?.city ?? null,
    minutesUntilKickoff,
    status: computeStatus(minutesUntilKickoff, false),
  };
}
