// Per-match data collection pipeline (Step 0 lookup + Step 1 sequential calls).
// Runs entirely client-side. Does NOT call Claude.

import { computeStatus, type AnalysedMatch } from "./fixtures";
import { apiFetch } from "./api-proxy.functions";
import {
  detectDeadRubber,
  applyDeadRubberDiscount,
  WC2026_QUALIFICATION,
} from "./calculate";
import {
  getApiCallCount,
  incrementApiCallCount,
  WARNING_THRESHOLD,
  CRITICAL_THRESHOLD,
} from "./apiCounter";

const AF_BASE = "https://v3.football.api-sports.io";
const SA_BASE = "https://api.thestatsapi.com/api";
// Hardcoded TheStatsAPI FIFA World Cup 2026 competition + season IDs.
const STATSAPI_COMPETITION_ID = "comp_6107";
const STATSAPI_SEASON_ID = "sn_118868";
// TheStatsAPI trips a *burst* rate limit even though the per-minute quota is
// high. Every TheStatsAPI call is therefore spaced by this fixed delay and run
// strictly sequentially (never Promise.all) — see saGet below.
const STATSAPI_DELAY_MS = 600;

// WC2026 group stage concluded the day before the Round of 32 began. Any last-5
// fixture whose UTC date is strictly before this falls inside the group-stage
// window and is a candidate for dead-rubber detection (see S6 below).
const WC2026_GROUP_STAGE_END = "2026-06-28";
// 3-match group stage (each team plays 3 group games in a group of 4).
const GROUP_TOTAL_MATCHDAYS = 3;



export type CallStatus = "SUCCESS" | "EMPTY" | "EXPECTED_EMPTY" | "FAILED" | "SKIPPED";

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

type ApiName = "API-Football" | "TheStatsAPI";

// A single raw HTTP call captured during a debug run.
export interface DebugEntry {
  api: ApiName;
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
  api: ApiName;
  endpoint: string;
  url: string;
  status: number | string;
  ok: boolean;
  dataExtracted: boolean;
  json: unknown;
  error?: string;
}

export interface DebugReport {
  rows: DebugCallRow[];
  afSucceeded: number;
  afTotal: number;
  statsapiSucceeded: number;
  statsapiTotal: number;
  readyForClaude: boolean;
  call10ExpectedEmpty: boolean;
  deadRubberTriggered: boolean;
  deadRubberFlagged: number;
  historicalCaveatEligible: boolean;
  historicalCaveatReason: string;
  wentToPenalties: boolean;
  penaltyShootoutNote: string;
}


export interface CollectionResult {
  callResults: Record<string, CallResult>;
  lineupResolved: boolean;
  succeeded: number;
  emptyOrFailed: number;
  failedCalls: string[];
  warning: string | null;
  counterWarning: boolean;
  debugEntries?: DebugEntry[];
  // S6 dead-rubber detection summary (group-stage games in last-5 form).
  deadRubberTriggered: boolean;
  deadRubberFlagged: number;
  // Rule 33 — Round of 32 historical base-rate staleness flag.
  historicalCaveatEligible: boolean;
  historicalCaveatReason: string;
  // Gap 6 — penalty-shootout detection from score.final_score (S0 lookup).
  wentToPenalties: boolean;
  penaltyShootoutNote: string;
}


// Module-level sink. When non-null, afGet/saGet record every raw HTTP call
// (url, status, parsed JSON) into it. collectMatchData wires this up for the
// duration of a single debug run, since the pipeline runs sequentially.
let debugSink: DebugEntry[] | null = null;

// Module-level label for the logical call currently executing. afGet/saGet
// stamp every captured DebugEntry with it so the Debug report can group raw
// HTTP calls under their logical CALL number (e.g. "2A", "6", "matches").
let currentDebugCall: string | null = null;

// Maps internal call keys to the endpoint labels used in the Claude prompt.
// Keys mirror the order the system prompt expects (CALL 2A ... CALL 10).
const CLAUDE_CALL_ORDER: Array<{ key: string; n: string; endpoint: string }> = [
  { key: "2A", n: "2A", endpoint: "TheStatsAPI /teams/{id}/stats (home)" },
  { key: "2B", n: "2B", endpoint: "TheStatsAPI /teams/{id}/stats (away)" },
  { key: "3", n: "3", endpoint: "/fixtures/headtohead" },
  { key: "4-3", n: "4", endpoint: "/fixtures/statistics (batch)" },
  { key: "5", n: "5", endpoint: "/injuries" },
  { key: "6", n: "6", endpoint: "TheStatsAPI /lineups" },
  { key: "6B", n: "6B", endpoint: "TheStatsAPI /players/{id}/stats" },
  { key: "7", n: "7", endpoint: "/fixtures (referee history)" },
  { key: "8", n: "8", endpoint: "/predictions" },
  { key: "9A", n: "9A", endpoint: "/odds (Stake)" },
  { key: "9B", n: "9B", endpoint: "TheStatsAPI Pinnacle odds" },
  { key: "10", n: "10", endpoint: "/fixtures (bracket)" },
];

/**
 * Per-call schema validation. Returns the data unchanged when the call-specific
 * required fields are present, or null when the response is structurally invalid
 * (so formatDataForClaude renders it as an EMPTY block instead of feeding Claude
 * malformed data). Validation is keyed by the logical CALL number.
 */
export function validateCall(callKey: string, data: unknown): unknown {
  if (data == null) return null;

  const d = data as Record<string, unknown>;
  // afGet already unwraps the API-Football `{ response: [...] }` envelope, so the
  // stored data is usually the bare array/object. Be tolerant of BOTH shapes:
  // treat the array itself as `resp` when data is already unwrapped, and fall
  // back to d.response when a full envelope is somehow present.
  const resp: unknown = Array.isArray(data) ? (data as unknown[]) : d.response;
  const firstResp =
    Array.isArray(resp) && resp.length ? (resp[0] as Record<string, unknown>) : undefined;

  const checks: Record<string, () => boolean> = {
    // TheStatsAPI team-stats shape: { teamId, extracted, raw }.
    "2A": () => !!(d.extracted || d.stats || firstResp?.statistics),
    "2B": () => !!(d.extracted || d.stats || firstResp?.statistics),
    "3": () => resp !== undefined,
    "4": () => resp !== undefined,
    "5": () => resp !== undefined,
    "6": () => !!(d.home || d.away || d.match_id) || resp !== undefined, // TheStatsAPI lineups shape
    "6B": () => !!(d.playerStatistics || d.playerCount),
    // CALL 7 is a derived referee profile object (no envelope) OR a raw response.
    "7": () => !!(d.referee || d.matches_officiated !== undefined) || resp !== undefined,
    "8": () => !!firstResp?.predictions || resp !== undefined,
    "9A": () => resp !== undefined,
    "9B": () => d.bookmakerOdds !== undefined || d.data !== undefined || d.markets !== undefined,
    "10": () => resp !== undefined,
  };

  const check = checks[callKey];
  if (check && !check()) {
    console.warn(`Call ${callKey} failed schema validation`, data);
    return null;
  }
  return data;
}

/**
 * Formats the collected call results into the [CALL N ... END CALL N] blocks
 * that the v3.0 system prompt expects. Call 9A (Stake odds) is split out of the
 * combined "9" result. Missing/empty/errored calls render as EMPTY blocks.
 */

export function formatDataForClaude(
  callResults: Record<string, CallResult> | null | undefined,
): string {
  // Defensive: never assume callResults (or any individual entry) exists.
  const safeResults: Record<string, CallResult> = callResults ?? {};

  // Safely pull the validated data out of a single call result. Runs the
  // per-call schema validator and drops the data if it fails.
  const getCallData = (key: string, validationKey?: string): unknown => {
    const result = safeResults[key];
    if (!result || result.status !== "SUCCESS" || result.data == null) {
      return null;
    }
    return validateCall(validationKey ?? key, result.data) === null && validationKey
      ? null
      : result.data;
  };

  // The odds step stores its data under key "9" (Stake only).
  const combinedOdds = safeResults["9"];
  const oddsData = (getCallData("9") ?? null) as {
    stakeOdds?: unknown;
  } | null;

  const resolved: Record<string, { status: CallStatus; data: unknown; error?: string }> = {};
  for (const [k, v] of Object.entries(safeResults)) {
    if (!v) continue;
    resolved[k] = { status: v.status, data: v.data ?? null, error: v.error };
  }
  // Synthesize 9A (Stake odds) from the combined "9" call.
  if (combinedOdds) {
    const stake = oddsData?.stakeOdds ?? null;
    resolved["9A"] = {
      status: isEmptyResponse(stake) || combinedOdds.status !== "SUCCESS" ? "EMPTY" : "SUCCESS",
      data: stake,
    };
  }

  // CALL 4 (recent form) gets the dead-rubber-adjusted averages appended to its
  // block instead of raw unweighted averages (see S6 in collectMatchData).
  const drInjection = safeResults["4-deadrubber"]?.data as
    | {
        home?: Record<string, unknown>;
        away?: Record<string, unknown>;
        dead_rubber_count?: number;
      }
    | null
    | undefined;
  const deadRubberSuffix = (n: string): string => {
    if (n !== "4" || !drInjection) return "";
    const count = drInjection.dead_rubber_count ?? 0;
    return (
      `\n\nRECENCY-WEIGHTED & DEAD-RUBBER-ADJUSTED FORM (feeds D1 Form — use these, not raw averages):\n` +
      `${JSON.stringify({ home: drInjection.home ?? null, away: drInjection.away ?? null }, null, 2)}\n` +
      `Note: Recency-weighted and dead-rubber-adjusted. ${count} fixture(s) discounted.`
    );
  };

  const blocks: string[] = [];
  for (const { key, n, endpoint } of CLAUDE_CALL_ORDER) {
    const r = resolved[key];
    // Validate the response shape before feeding it to Claude. validateCall
    // returns null for structurally invalid responses.
    const validated =
      r && r.status === "SUCCESS" && r.data !== null
        ? validateCall(n, r.data)
        : null;
    const hasData = validated !== null && !isEmptyResponse(validated);
    if (hasData) {
      blocks.push(
        `[CALL ${n} — ${endpoint} — SUCCESS]\n${JSON.stringify(validated, null, 2)}${deadRubberSuffix(n)}\n[END CALL ${n}]`,
      );
    } else if (r?.status === "EXPECTED_EMPTY") {
      blocks.push(
        `[CALL ${n} — bracket context — EXPECTED EMPTY]\nNext round fixtures not yet scheduled. Round of 32 still in progress. Bracket context unavailable.\n[END CALL ${n}]`,
      );

    } else {
      const note = r?.error ? `\n${r.error}` : "";
      blocks.push(
        `[CALL ${n} — ${endpoint} — EMPTY]\nNo data available for this call.${note}${deadRubberSuffix(n)}\n[END CALL ${n}]`,
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

  const odds = cr["9"]?.data as { stakeOdds?: unknown } | undefined;

  interface Spec {
    callLabel: string;
    api: ApiName;
    endpoint: string;
    entryKey: string;
    crKey?: string;
    extracted: boolean;
    count: boolean;
  }

  const specs: Spec[] = [
    // ---- TheStatsAPI group (6 calls: S0, S2A, S2B, S3, S4, S5) ----
    { callLabel: "S0", api: "TheStatsAPI", endpoint: "match lookup /football/matches", entryKey: "S0", extracted: cr["S0"]?.status === "SUCCESS", count: true },
    { callLabel: "S2A", api: "TheStatsAPI", endpoint: "/teams/{home}/stats", entryKey: "2A", extracted: cr["2A"]?.status === "SUCCESS", count: true },
    { callLabel: "S2B", api: "TheStatsAPI", endpoint: "/teams/{away}/stats", entryKey: "2B", extracted: cr["2B"]?.status === "SUCCESS", count: true },
    { callLabel: "S3", api: "TheStatsAPI", endpoint: "/matches/{id}/lineups", entryKey: "6", extracted: cr["6"]?.status === "SUCCESS", count: true },
    { callLabel: "S4", api: "TheStatsAPI", endpoint: "/players/{id}/stats (if absences)", entryKey: "6B", extracted: cr["6B"]?.status === "SUCCESS", count: true },
    { callLabel: "S5", api: "TheStatsAPI", endpoint: "/matches/{id}/odds (Pinnacle → first-bookmaker fallback)", entryKey: "9B", extracted: cr["9B"]?.status === "SUCCESS", count: true },
    { callLabel: "S6", api: "TheStatsAPI", endpoint: "/standings (all groups, 3rd-place-aware dead-rubber check)", entryKey: "S6", extracted: cr["S6"]?.status === "SUCCESS", count: false },
    { callLabel: "S7", api: "TheStatsAPI", endpoint: "/matches/{id}/referee (career totals) + API-Football fouls/penalties enrichment", entryKey: "7", extracted: cr["7"]?.status === "SUCCESS", count: true },
    // ---- API-Football group ----
    { callLabel: "CALL 3", api: "API-Football", endpoint: "/fixtures/headtohead", entryKey: "3", extracted: cr["3"]?.status === "SUCCESS", count: true },
    { callLabel: "CALL 4", api: "API-Football", endpoint: "/fixtures (last 5 each team)", entryKey: "4", crKey: "4-3", extracted: cr["4-3"]?.status === "SUCCESS", count: true },
    { callLabel: "CALL 5", api: "API-Football", endpoint: "/injuries", entryKey: "5", extracted: cr["5"]?.status === "SUCCESS", count: true },
    
    { callLabel: "CALL 8", api: "API-Football", endpoint: "/predictions", entryKey: "8", extracted: cr["8"]?.status === "SUCCESS", count: true },
    { callLabel: "CALL 9A", api: "API-Football", endpoint: "/odds (Stake)", entryKey: "9A", extracted: hasUsableData(odds?.stakeOdds), count: true },
    { callLabel: "CALL 10", api: "API-Football", endpoint: "/fixtures (bracket context)", entryKey: "10", extracted: cr["10"]?.status === "SUCCESS", count: true },
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
  const afSucceeded = afCount.filter((s) => s.extracted).length;

  const saCount = specs.filter((s) => s.api === "TheStatsAPI" && s.count);
  const statsapiSucceeded = saCount.filter((s) => s.extracted).length;

  // Claude can run as long as the two mandatory team-statistics calls landed.
  // Optional calls (lineups/referee/bracket/Pinnacle) may be EMPTY without blocking.
  const readyForClaude =
    cr["2A"]?.status === "SUCCESS" && cr["2B"]?.status === "SUCCESS";

  return {
    rows,
    afSucceeded,
    afTotal: afCount.length,
    statsapiSucceeded,
    statsapiTotal: saCount.length,
    readyForClaude,
    call10ExpectedEmpty: cr["10"]?.status === "EXPECTED_EMPTY",
    deadRubberTriggered: result.deadRubberTriggered ?? false,
    deadRubberFlagged: result.deadRubberFlagged ?? 0,
    historicalCaveatEligible: result.historicalCaveatEligible ?? false,
    historicalCaveatReason:
      result.historicalCaveatReason ??
      "NOT ELIGIBLE — round unknown.",
    wentToPenalties: result.wentToPenalties ?? false,
    penaltyShootoutNote: result.penaltyShootoutNote ?? "Not evaluated.",
  };
}



const TOTAL_STEPS = 13;

function normalize(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
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

// TheStatsAPI GET (via server proxy). The server attaches the Bearer token.
//
// Throttling contract (fixes the "too many requests" burst errors):
//   - Every call logs "TheStatsAPI call {label} starting at {timestamp}" so the
//     console shows exactly how fast calls fire.
//   - On HTTP 429: log the error body + Retry-After header, wait 3s, retry ONCE.
//     If it 429s again the error is thrown so the caller marks that single call
//     EMPTY/FAILED and the pipeline continues (it does not block everything).
//   - After EVERY call we wait STATSAPI_DELAY_MS (400ms) so the next sequential
//     TheStatsAPI call is spaced out. Callers must never run saGet in parallel.
//   - On 404 we return null (used for lineups "not announced yet").
async function saGet(path: string): Promise<unknown> {
  const url = `${SA_BASE}${path}`;
  const label = currentDebugCall ?? "?";

  const attempt = async (): Promise<{
    ok: boolean;
    status: number | string;
    statusText?: string;
    retryAfter?: string | null;
    json: unknown;
  }> => {
    try {
      return await apiFetch({ data: { provider: "statsapi", url } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, status: "network error", statusText: msg, json: null };
    }
  };

  console.log(`TheStatsAPI call ${label} starting at ${new Date().toISOString()}`);
  let result = await attempt();

  // Rate limit: log the exact error + Retry-After, wait 3s, retry exactly once.
  if (!result.ok && String(result.status) === "429") {
    console.warn(
      `[TheStatsAPI] 429 rate limit on call ${label}. ` +
        `Retry-After: ${result.retryAfter ?? "(none)"} — waiting 3s then retrying once.`,
      { status: result.status, body: result.json },
    );
    await sleep(3000);
    console.log(`TheStatsAPI call ${label} retrying at ${new Date().toISOString()}`);
    result = await attempt();
    if (!result.ok && String(result.status) === "429") {
      console.error(
        `[TheStatsAPI] 429 again on call ${label} after retry — marking this call ` +
          `EMPTY/FAILED and continuing the pipeline.`,
        { status: result.status, body: result.json },
      );
    }
  }

  // Always space subsequent TheStatsAPI calls so a burst never trips the limiter.
  await sleep(STATSAPI_DELAY_MS);

  // 404 = resource not yet available (e.g. lineups not announced). Treat as null.
  if (!result.ok && String(result.status) === "404") {
    debugSink?.push({ api: "TheStatsAPI", url, status: 404, ok: true, json: null, callLabel: currentDebugCall ?? undefined });
    return null;
  }

  if (!result || !result.ok) {
    const status = result?.status ?? "no response";
    // Surface the TheStatsAPI error body so an invalid/expired key is obvious.
    const bodyErr =
      getField(getField(result?.json, ["error"]), ["message"]) ??
      getField(result?.json, ["message", "error"]);
    const detail =
      (typeof bodyErr === "string" && bodyErr) || result?.statusText || "";
    const hint =
      String(status) === "401" || String(status) === "403"
        ? " — the STATSAPI_KEY secret is invalid or expired; update it with a valid key from thestatsapi.com"
        : "";
    debugSink?.push({ api: "TheStatsAPI", url, status, ok: false, json: result?.json ?? null, error: `${detail}${hint}`, callLabel: currentDebugCall ?? undefined });
    throw new Error(`TheStatsAPI ${status} ${detail}${hint}`.trim());
  }
  const json = result.json ?? null;
  debugSink?.push({ api: "TheStatsAPI", url, status: result.status, ok: true, json, callLabel: currentDebugCall ?? undefined });
  // TheStatsAPI wraps payloads in { data: ... }. Return the inner data.
  return getField(json, ["data"]) ?? json;
}

// --- Pinnacle line-movement helpers ---

function toNum(x: unknown): number | null {
  if (typeof x === "number" && Number.isFinite(x)) return x;
  if (typeof x === "string") {
    const n = parseFloat(x);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// Movement signal from opening -> current price (lower price = shortened).
function movementSignal(
  opening: number | null,
  current: number | null,
): { movement_pct: number | null; signal: string } {
  if (opening == null || current == null || opening === 0) {
    return { movement_pct: null, signal: "UNKNOWN" };
  }
  const movement_pct = ((current - opening) / opening) * 100;
  let signal: string;
  if (movement_pct <= -8) signal = "SHARP MOVE"; // shortened > 8%
  else if (movement_pct >= 8) signal = "DRIFT"; // drifted > 8%
  else if (Math.abs(movement_pct) < 5) signal = "STABLE";
  else signal = "BORDERLINE"; // 5-8% either direction
  return { movement_pct: Math.round(movement_pct * 100) / 100, signal };
}

interface PinnacleMarketSummary {
  market: string;
  outcomes: Array<{
    name: string;
    current: number | null; // last_seen
    opening: number | null;
    movement_pct: number | null;
    signal: string;
  }>;
}

// Pull opening + last_seen prices out of a TheStatsAPI odds outcome node and
// derive the line-movement signal. movement_pct = (last_seen - opening)/opening*100.
function summariseOutcome(name: string, node: unknown) {
  const opening = toNum(getField(node, ["opening"]));
  const current = toNum(getField(node, ["last_seen", "last", "current"]));
  const mv = movementSignal(opening, current);
  return { name, opening, current, ...mv };
}

// Build a structured odds summary from a TheStatsAPI /matches/{id}/odds
// response. Prefers the Pinnacle bookmaker (sharp money); when Pinnacle is not
// among the returned bookmakers — real WC2026 data frequently ships a single
// bookmaker such as Bet365 — it falls back to the first bookmaker present so the
// markets are not silently dropped. Extracts 1X2, BTTS, Total Goals, Corners and
// Asian Handicap with opening + last_seen prices and line movement.
//
// CRITICAL (per authoritative spec at api.thestatsapi.com/llms.txt): for
// total_goals, match_corners and asian_handicap the LINE VALUE is the object KEY
// (e.g. "2.5", "9.5", "-0.5"), NOT a fixed field name like over_2_5. We iterate
// the keys dynamically and keep whatever lines are actually present.
function buildPinnacleSummary(
  oddsJson: unknown,
): { bookmaker: string; markets: PinnacleMarketSummary[]; raw: unknown } | null {
  const bookmakers = extractArray(getField(oddsJson, ["bookmakers"]) ?? oddsJson);
  if (!bookmakers.length) return null;
  // Prefer Pinnacle; otherwise fall back to the first available bookmaker.
  const chosen =
    bookmakers.find((b) => {
      const name = getField(b, ["bookmaker", "name"]);
      return typeof name === "string" && normalize(name).includes("pinnacle");
    }) ?? bookmakers[0];
  const bookmakerName = (getField(chosen, ["bookmaker", "name"]) as string) ?? "UNKNOWN";
  const m = getField(chosen, ["markets"]);
  if (!m || typeof m !== "object") return null;

  const markets: PinnacleMarketSummary[] = [];

  // 1X2 — match_odds (home / draw / away). Each outcome is a flat
  // { opening, last_seen } node.
  const matchOdds = getField(m, ["match_odds", "match_result", "1x2"]);
  if (matchOdds) {
    const outcomes = (
      [
        ["Home", getField(matchOdds, ["home"])],
        ["Draw", getField(matchOdds, ["draw"])],
        ["Away", getField(matchOdds, ["away"])],
      ] as Array<[string, unknown]>
    )
      .filter(([, n]) => n != null)
      .map(([name, n]) => summariseOutcome(name, n));
    if (outcomes.length) markets.push({ market: "1X2 Full Time Result", outcomes });
  }

  // BTTS — yes / no.
  const btts = getField(m, ["btts"]);
  if (btts) {
    const outcomes = (
      [
        ["Yes", getField(btts, ["yes"])],
        ["No", getField(btts, ["no"])],
      ] as Array<[string, unknown]>
    )
      .filter(([, n]) => n != null)
      .map(([name, n]) => summariseOutcome(name, n));
    if (outcomes.length) markets.push({ market: "BTTS", outcomes });
  }

  // Over/Under goals + corners — dynamic line keys. `preferredLine` is the line
  // we most want (2.5 goals, 9.5 corners); if it is absent we do NOT error, we
  // keep whatever lines ARE returned and log which keys the match actually had.
  const flattenLines = (label: string, container: unknown, preferredLine: number) => {
    if (!container || typeof container !== "object") return;
    const keys = Object.keys(container as Record<string, unknown>);
    console.log(`[analyse] ${label} lines returned:`, keys);
    if (!keys.some((k) => parseFloat(k) === preferredLine)) {
      console.log(
        `[analyse] ${label}: preferred line ${preferredLine} not present — falling back to available lines.`,
      );
    }
    const outcomes: PinnacleMarketSummary["outcomes"] = [];
    for (const [line, node] of Object.entries(container as Record<string, unknown>)) {
      const over = getField(node, ["over"]);
      const under = getField(node, ["under"]);
      if (over) outcomes.push(summariseOutcome(`Over ${line}`, over));
      if (under) outcomes.push(summariseOutcome(`Under ${line}`, under));
    }
    if (outcomes.length) markets.push({ market: label, outcomes });
  };
  flattenLines("Over/Under Goals", getField(m, ["total_goals", "totals"]), 2.5);
  flattenLines("Corners", getField(m, ["match_corners", "corners"]), 9.5);

  // Asian Handicap — { home: { "<line>": {opening,last_seen}, ... },
  //                    away: { "<line>": {opening,last_seen}, ... } }.
  // The handicap line is the nested object KEY, so iterate dynamically rather
  // than reading opening/last_seen straight off home/away (which are containers,
  // not price nodes — the old code did this and always got undefined).
  const ah = getField(m, ["asian_handicap", "handicap"]);
  if (ah && typeof ah === "object") {
    const ahOutcomes: PinnacleMarketSummary["outcomes"] = [];
    for (const side of ["home", "away"] as const) {
      const sideObj = getField(ah, [side]);
      if (!sideObj || typeof sideObj !== "object") continue;
      const lines = Object.keys(sideObj as Record<string, unknown>);
      console.log(`[analyse] Asian Handicap ${side} lines returned:`, lines);
      for (const [line, node] of Object.entries(sideObj as Record<string, unknown>)) {
        ahOutcomes.push(
          summariseOutcome(`${side === "home" ? "Home" : "Away"} ${line}`, node),
        );
      }
    }
    if (ahOutcomes.length) markets.push({ market: "Asian Handicap", outcomes: ahOutcomes });
  }

  return markets.length ? { bookmaker: bookmakerName, markets, raw: chosen } : null;
}

// Extract Stake 1X2 (Match Winner) odds from an API-Football /odds response.
function extractStake1X2(stakeOdds: unknown): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  const responseArr = extractArray(stakeOdds);
  for (const item of responseArr) {
    const bookmakers = extractArray(getField(item, ["bookmakers"]));
    for (const bk of bookmakers) {
      const bets = extractArray(getField(bk, ["bets"]));
      for (const bet of bets) {
        const betName = String(getField(bet, ["name"]) ?? "").toLowerCase();
        if (!/match winner|1x2|full time result/.test(betName)) continue;
        const values = extractArray(getField(bet, ["values"]));
        for (const v of values) {
          const vname = String(getField(v, ["value"]) ?? "").toLowerCase();
          const odd = toNum(getField(v, ["odd", "odds", "price"]));
          if (vname.includes("home") || vname === "1") out["Home"] = odd;
          else if (vname.includes("draw") || vname === "x") out["Draw"] = odd;
          else if (vname.includes("away") || vname === "2") out["Away"] = odd;
        }
      }
    }
  }
  return out;
}

// Step 4 — gap check: compare Stake odds vs Pinnacle current odds (1X2).
// Higher decimal odds = better price for the bettor.
function buildStakeGapCheck(
  stakeOdds: unknown,
  markets: PinnacleMarketSummary[],
): Array<{ outcome: string; stake: number | null; pinnacle: number | null; verdict: string }> {
  const stake1X2 = extractStake1X2(stakeOdds);
  const pinnacle1X2 = markets.find((m) => m.market === "1X2 Full Time Result");
  if (!pinnacle1X2) return [];
  return pinnacle1X2.outcomes
    .filter((o) => ["Home", "Draw", "Away"].includes(o.name))
    .map((o) => {
      const stakePrice = stake1X2[o.name] ?? null;
      const pinPrice = o.current;
      let verdict = "UNKNOWN";
      if (stakePrice != null && pinPrice != null) {
        if (stakePrice > pinPrice) verdict = "STAKE OFFERS VALUE";
        else if (pinPrice > stakePrice) verdict = "STAKE WORSE";
        else verdict = "EQUAL";
      }
      return { outcome: o.name, stake: stakePrice, pinnacle: pinPrice, verdict };
    });
}





function isEmptyResponse(response: unknown): boolean {
  if (response === null || response === undefined) return true;
  if (Array.isArray(response)) return response.length === 0;
  if (typeof response === "object")
    return Object.keys(response as object).length === 0;
  return false;
}

// Pull an array out of common API-Football envelope shapes.
function extractArray(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    for (const field of ["data", "response", "results"]) {
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

function nextRound(current: string | null): string | null {

  if (!current) return null;
  const c = current.toLowerCase();
  if (c.includes("32")) return "Round of 16";
  if (c.includes("16")) return "Quarter-finals";
  if (c.includes("quarter")) return "Semi-finals";
  if (c.includes("semi")) return "Final";
  return null;
}


function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---- CALL 7 referee history (client-side derivation) ----
//
// API-Football does NOT support filtering fixtures by referee name (the
// `referee` query parameter returns "The Referee field do not exist"). Instead
// we pull ALL completed World Cup fixtures for a season once, cache them for the
// day, then filter client-side by the referee name extracted from CALL 1.

// Day-scoped in-memory cache of completed fixtures per season so the (large)
// /fixtures?status=FT-AET-PEN call runs at most once per season per day.
const completedFixturesMem: Record<string, unknown[]> = {};

async function getCompletedFixtures(season: number): Promise<unknown[]> {
  const dateKey = new Date().toISOString().slice(0, 10);
  const memKey = `${season}_${dateKey}`;
  if (completedFixturesMem[memKey]) return completedFixturesMem[memKey];

  const lsKey = `wc_completed_fixtures_${season}_${dateKey}`;
  if (typeof window !== "undefined") {
    const raw = window.localStorage.getItem(lsKey);
    if (raw) {
      try {
        const arr = JSON.parse(raw) as unknown[];
        completedFixturesMem[memKey] = arr;
        return arr;
      } catch {
        /* fall through and refetch */
      }
    }
  }

  const r = await afGet(
    `/fixtures?league=1&season=${season}&status=FT-AET-PEN`,
  );
  const arr = extractArray(r);
  completedFixturesMem[memKey] = arr;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(lsKey, JSON.stringify(arr));
    } catch {
      /* localStorage quota — keep the in-memory cache only */
    }
  }
  return arr;
}

// Case-insensitive, accent-insensitive "contains" check both ways, since
// referee names vary slightly between API responses.
function refereeMatches(fixtureRef: unknown, target: string): boolean {
  if (typeof fixtureRef !== "string") return false;
  const a = normalize(fixtureRef);
  const b = normalize(target);
  if (!a || !b) return false;
  return a.includes(b) || b.includes(a);
}

// Sum a numeric statistic of a given type across both teams of one fixture's
// /fixtures/statistics payload. Returns null when the stat is unavailable.
function sumStatType(statsResponse: unknown, type: string): number | null {
  const teams = extractArray(statsResponse);
  if (!teams.length) return null;
  let total = 0;
  let seen = false;
  for (const team of teams) {
    const stats = extractArray(getField(team, ["statistics"]));
    for (const s of stats) {
      const t = getField(s, ["type"]);
      if (typeof t === "string" && normalize(t) === normalize(type)) {
        const v = getField(s, ["value"]);
        const n = typeof v === "number" ? v : parseInt(String(v ?? ""), 10);
        if (Number.isFinite(n)) {
          total += n;
          seen = true;
        }
      }
    }
  }
  return seen ? total : null;
}

interface RefereeProfile {
  referee: string;
  matches_officiated: number;
  seasons_used: number[];
  avg_yellow_cards_per_game: number | string;
  avg_fouls_per_game: number | string;
  penalties_awarded: number | string;
  sample_fixtures_with_stats: number;
  source?: string;
  career_totals?: {
    games: number | null;
    yellow_cards: number | null;
    red_cards: number | null;
    yellow_red_cards: number | null;
  };
}

// ---- S7: dedicated TheStatsAPI referee endpoint ----
//
// GET /football/matches/{match_id}/referee returns the assigned referee with
// CAREER TOTALS (games, yellow_cards, red_cards, yellow_red_cards) — NOT
// averages. We derive avg_yellow_cards_per_game = yellow_cards / games. The
// endpoint does NOT expose fouls-per-game or penalties-per-game, so those stay
// NOT_AVAILABLE here and are filled (when possible) from API-Football. `referee`
// is null when no referee is assigned yet — caller falls back to API-Football.
function buildRefereeProfileFromStatsApi(refNode: unknown): RefereeProfile | null {
  const name = getField(refNode, ["name"]);
  if (!name) return null;
  const career = getField(refNode, ["career"]);
  const games = toNum(getField(career, ["games"]));
  const yellows = toNum(getField(career, ["yellow_cards"]));
  const reds = toNum(getField(career, ["red_cards"]));
  const yellowReds = toNum(getField(career, ["yellow_red_cards"]));
  const avgYellow =
    games && games > 0 && yellows != null
      ? Math.round((yellows / games) * 100) / 100
      : "NOT_AVAILABLE";
  return {
    referee: String(name),
    matches_officiated: games ?? 0,
    seasons_used: [],
    avg_yellow_cards_per_game: avgYellow,
    avg_fouls_per_game: "NOT_AVAILABLE",
    penalties_awarded: "NOT_AVAILABLE",
    sample_fixtures_with_stats: games ?? 0,
    source: "TheStatsAPI /matches/{id}/referee (career totals)",
    career_totals: {
      games,
      yellow_cards: yellows,
      red_cards: reds,
      yellow_red_cards: yellowReds,
    },
  };
}

// Build a referee profile from cached completed fixtures, optionally enriching
// with per-fixture statistics (yellow cards / fouls / penalties). `withStats`
// is disabled when the daily API budget is near its limit.
async function buildRefereeProfile(
  refName: string,
  withStats: boolean,
): Promise<RefereeProfile | null> {
  // Step 1+4: gather matching fixtures across 2026, falling back to 2022.
  const matchingByFixtureId = new Map<string, unknown>();
  const seasonsUsed: number[] = [];

  const collectSeason = async (season: number) => {
    const fixtures = await getCompletedFixtures(season);
    let added = 0;
    for (const fx of fixtures) {
      const ref = getField(getField(fx, ["fixture"]), ["referee"]);
      if (refereeMatches(ref, refName)) {
        const id = String(getField(getField(fx, ["fixture"]), ["id"]) ?? "");
        if (id && !matchingByFixtureId.has(id)) {
          matchingByFixtureId.set(id, fx);
          added++;
        }
      }
    }
    if (added > 0 && !seasonsUsed.includes(season)) seasonsUsed.push(season);
  };

  await collectSeason(2026);
  // Step 4: if fewer than 3 found in 2026, also pull 2022 and combine.
  if (matchingByFixtureId.size < 3) {
    await collectSeason(2022);
  }

  // Step 5: still nothing -> UNKNOWN.
  if (matchingByFixtureId.size === 0) return null;

  const matching = [...matchingByFixtureId.values()];
  const profile: RefereeProfile = {
    referee: refName,
    matches_officiated: matching.length,
    seasons_used: seasonsUsed,
    avg_yellow_cards_per_game: "NOT_AVAILABLE",
    avg_fouls_per_game: "NOT_AVAILABLE",
    penalties_awarded: "NOT_AVAILABLE",
    sample_fixtures_with_stats: 0,
  };

  // Step 3: derive card/foul/penalty averages from per-fixture statistics.
  // Each statistics call costs one API request, so cap the sample and skip
  // entirely when the budget is near its limit.
  if (withStats) {
    const MAX_STAT_FIXTURES = 8;
    const sample = matching.slice(0, MAX_STAT_FIXTURES);
    let yellowTotal = 0;
    let foulTotal = 0;
    let penaltyTotal = 0;
    let yellowGames = 0;
    let foulGames = 0;
    for (const fx of sample) {
      const id = getField(getField(fx, ["fixture"]), ["id"]);
      if (id == null) continue;
      try {
        const stats = await afGet(`/fixtures/statistics?fixture=${id}`);
        const yellows = sumStatType(stats, "Yellow Cards");
        const fouls = sumStatType(stats, "Fouls");
        const pens = sumStatType(stats, "Penalty");
        if (yellows != null) {
          yellowTotal += yellows;
          yellowGames++;
        }
        if (fouls != null) {
          foulTotal += fouls;
          foulGames++;
        }
        if (pens != null) penaltyTotal += pens;
      } catch {
        /* skip this fixture's stats */
      }
    }
    profile.sample_fixtures_with_stats = Math.max(yellowGames, foulGames);
    if (yellowGames > 0) {
      profile.avg_yellow_cards_per_game =
        Math.round((yellowTotal / yellowGames) * 100) / 100;
    }
    if (foulGames > 0) {
      profile.avg_fouls_per_game =
        Math.round((foulTotal / foulGames) * 100) / 100;
    }
    if (yellowGames > 0 || foulGames > 0) {
      profile.penalties_awarded = penaltyTotal;
    }
  }

  return profile;
}

// ---- TheStatsAPI match resolution (S0) ----
//
// TheStatsAPI is now the primary source for team stats (S2A/S2B), confirmed
// lineups (S3), player stats (S4) and Pinnacle odds (S5). All of those need
// TheStatsAPI's own match_id AND the per-team ids, which both come from the
// match-lookup response. We resolve it once per pipeline run by listing FIFA
// World Cup 2026 matches for the kickoff date (competition + season hardcoded),
// matching by team name. The match list is cached per-day in localStorage under
// "statsapi_matches_{YYYY-MM-DD}". Lineups and Pinnacle odds are NEVER cached.
const statsapiMatchListMem: Record<string, unknown[]> = {};

async function getStatsApiMatches(date: string): Promise<unknown[]> {
  if (statsapiMatchListMem[date]) return statsapiMatchListMem[date];

  // Daily localStorage cache of the match list (not lineups/odds).
  const lsKey = `statsapi_matches_${date}`;
  if (typeof window !== "undefined") {
    const raw = window.localStorage.getItem(lsKey);
    if (raw) {
      try {
        const arr = JSON.parse(raw) as unknown[];
        statsapiMatchListMem[date] = arr;
        return arr;
      } catch {
        /* fall through and refetch */
      }
    }
  }

  // Correct endpoint: date_from + date_to (there is no ?date= param), and
  // status=scheduled for upcoming fixtures.
  const base =
    `/football/matches?competition_id=${STATSAPI_COMPETITION_ID}` +
    `&season_id=${STATSAPI_SEASON_ID}&date_from=${date}&date_to=${date}&per_page=100`;
  let payload = await saGet(`${base}&status=scheduled`);
  let arr = extractArray(payload);

  // Fallback: completed/in-play fixtures (e.g. Debug Mode uses a past match)
  // do not appear under status=scheduled. Retry without the status filter.
  if (arr.length === 0) {
    payload = await saGet(base);
    arr = extractArray(payload);
  }

  statsapiMatchListMem[date] = arr;
  if (typeof window !== "undefined" && arr.length) {
    try {
      window.localStorage.setItem(lsKey, JSON.stringify(arr));
    } catch {
      /* localStorage quota — keep the in-memory cache only */
    }
  }
  return arr;
}

export interface PenaltyShootout {
  aggregate: { home: number | null; away: number | null }; // SofaScore final_score
  normal_time: { home: number | null; away: number | null };
  shootout_score: { home: number | null; away: number | null };
}

export interface StatsApiMatchRef {
  id: string;
  homeTeamId: string | null;
  awayTeamId: string | null;
  homeTeamName: string | null;
  awayTeamName: string | null;
  // Gap 6: derived from score.final_score vs score.home/away. When final_score
  // differs from normal-time goals the match went to penalties (status strings
  // are NOT used for this — only the score fields per the authoritative spec).
  wentToPenalties: boolean;
  penaltyShootout: PenaltyShootout | null;
  raw: unknown;
}

function idOrNull(v: unknown): string | null {
  return v == null ? null : String(v);
}

// Resolve the TheStatsAPI match (id + team ids) for a fixture by team name on
// its kickoff date. Case-insensitive "contains" check in both directions, since
// API-Football and TheStatsAPI name teams slightly differently. Returns null
// when no match is found.
async function resolveStatsApiMatch(
  home: string,
  away: string,
  kickoffUtc: string,
): Promise<StatsApiMatchRef | null> {
  const date = (kickoffUtc || "").slice(0, 10);
  if (!date) return null;
  const list = await getStatsApiMatches(date);
  const h = normalize(home);
  const a = normalize(away);
  const found = list.find((mt) => {
    const hn = normalize(String(getField(getField(mt, ["home_team"]), ["name"]) ?? ""));
    const an = normalize(String(getField(getField(mt, ["away_team"]), ["name"]) ?? ""));
    if (!hn && !an) return false;
    return (
      hn.includes(h) ||
      an.includes(h) ||
      hn.includes(a) ||
      an.includes(a) ||
      h.includes(hn) ||
      a.includes(an)
    );
  });
  if (!found) return null;
  const id = getField(found, ["id", "match_id"]);
  if (id == null) return null;

  // Gap 6: penalty-shootout detection from score.final_score vs normal time.
  const score = getField(found, ["score"]);
  const ntHome = toNum(getField(score, ["home"]));
  const ntAway = toNum(getField(score, ["away"]));
  const fs = getField(score, ["final_score"]);
  const fsHome = toNum(getField(fs, ["home"]));
  const fsAway = toNum(getField(fs, ["away"]));
  let wentToPenalties = false;
  let penaltyShootout: PenaltyShootout | null = null;
  if (fs && fsHome != null && fsAway != null && (fsHome !== ntHome || fsAway !== ntAway)) {
    wentToPenalties = true;
    penaltyShootout = {
      aggregate: { home: fsHome, away: fsAway },
      normal_time: { home: ntHome, away: ntAway },
      shootout_score: {
        home: ntHome != null ? fsHome - ntHome : null,
        away: ntAway != null ? fsAway - ntAway : null,
      },
    };
  }

  return {
    id: String(id),
    homeTeamId: idOrNull(getField(getField(found, ["home_team"]), ["id", "team_id"])),
    awayTeamId: idOrNull(getField(getField(found, ["away_team"]), ["id", "team_id"])),
    homeTeamName: (getField(getField(found, ["home_team"]), ["name"]) as string) ?? null,
    awayTeamName: (getField(getField(found, ["away_team"]), ["name"]) as string) ?? null,
    wentToPenalties,
    penaltyShootout,
    raw: found,
  };
}

// Back-compat wrapper used by refetchLineups: resolve just the match_id.
async function resolveStatsApiMatchId(
  home: string,
  away: string,
  kickoffUtc: string,
): Promise<string | null> {
  const ref = await resolveStatsApiMatch(home, away, kickoffUtc);
  return ref?.id ?? null;
}

// ---- TheStatsAPI extraction helpers ----

// Extract the key season-stat fields from a TheStatsAPI /teams/{id}/stats
// response. Keeps the raw payload too so Claude still sees everything.
function extractTeamStats(raw: unknown): Record<string, unknown> {
  const d = (getField(raw, ["stats", "statistics", "data"]) ?? raw) as unknown;
  const goals = getField(d, ["goals"]);
  return {
    form: getField(d, ["form", "recent_form"]) ?? null,
    goals_for:
      getField(d, ["goals_for", "goalsFor"]) ??
      getField(goals, ["for", "scored"]) ??
      null,
    goals_against:
      getField(d, ["goals_against", "goalsAgainst"]) ??
      getField(goals, ["against", "conceded"]) ??
      null,
    wins: getField(d, ["wins", "won"]) ?? null,
    draws: getField(d, ["draws", "drawn"]) ?? null,
    losses: getField(d, ["losses", "lost", "loses"]) ?? null,
    matches_played:
      getField(d, ["matches_played", "matchesPlayed", "played", "games_played"]) ?? null,
    position: getField(d, ["position", "rank", "standing"]) ?? null,
  };
}

// Pull the starting_xi player ids out of a TheStatsAPI lineups response.
function extractLineupPlayerIds(lineup: unknown): string[] {
  const ids = new Set<string>();
  const collectSide = (side: unknown) => {
    const xi = getField(side, ["starting_xi", "startingXi", "startingXI", "lineup"]);
    for (const p of extractArray(xi)) {
      const id =
        getField(p, ["player_id", "id"]) ?? getField(getField(p, ["player"]), ["id"]);
      if (id != null) ids.add(String(id));
    }
  };
  collectSide(getField(lineup, ["home"]));
  collectSide(getField(lineup, ["away"]));
  // Array-shaped lineup responses (one entry per team).
  for (const item of extractArray(lineup)) collectSide(item);
  return [...ids];
}

// Extract the player-stat fields the GAP formula needs from a TheStatsAPI
// /players/{id}/stats response.
function extractPlayerStats(raw: unknown): Record<string, unknown> {
  const d = (getField(raw, ["stats", "statistics", "data"]) ?? raw) as unknown;
  const scoring = getField(d, ["scoring"]);
  const shooting = getField(d, ["shooting"]);
  const passing = getField(d, ["passing"]);
  const discipline = getField(d, ["discipline"]);
  return {
    appearances: getField(d, ["appearances", "apps"]) ?? null,
    starts: getField(d, ["starts"]) ?? null,
    minutes_played: getField(d, ["minutes_played", "minutesPlayed", "minutes"]) ?? null,
    "scoring.goals": getField(scoring, ["goals"]) ?? null,
    "scoring.assists": getField(scoring, ["assists"]) ?? null,
    "shooting.total_shots": getField(shooting, ["total_shots", "shots"]) ?? null,
    "shooting.shots_on_target": getField(shooting, ["shots_on_target", "on_target"]) ?? null,
    "passing.key_passes": getField(passing, ["key_passes", "keyPasses"]) ?? null,
    "discipline.yellow_cards": getField(discipline, ["yellow_cards", "yellows"]) ?? null,
    "discipline.red_cards": getField(discipline, ["red_cards", "reds"]) ?? null,
  };
}

// ---- S6: dead-rubber detection (group-stage games in last-5 form) ----
//
// See the CALL SEQUENCE EXPLANATION comment in src/lib/calculate.ts: this whole
// block is only reachable while a team's last-5 still contains group-stage
// fixtures (early knockout rounds). It naturally goes dark by the QFs.

interface ParsedLast5Fixture {
  matchday: number;
  date: string;
  opponentName: string;
  goals_scored: number;
  shots_on_target: number;
  is_group_stage: boolean;
  is_dead_rubber: boolean;
}

// Parse an API-Football last-5 fixtures list (CALL 4-1 / 4-2) into the minimal
// shape the dead-rubber logic needs, from the perspective of `teamId`.
function parseLast5(list: unknown, teamId: number): ParsedLast5Fixture[] {
  return extractArray(list).map((item) => {
    const fixture = getField(item, ["fixture"]);
    const date = String(getField(fixture, ["date"]) ?? "");
    const round = String(getField(getField(item, ["league"]), ["round"]) ?? "");
    const teams = getField(item, ["teams"]);
    const home = getField(teams, ["home"]);
    const away = getField(teams, ["away"]);
    const homeId = Number(getField(home, ["id"]));
    const isHome = homeId === teamId;
    const goals = getField(item, ["goals"]);
    const goals_scored =
      Number(getField(goals, [isHome ? "home" : "away"]) ?? 0) || 0;
    const opp = isHome ? away : home;
    const opponentName = String(getField(opp, ["name"]) ?? "");
    // Group-stage if the round names a group OR the date is before knockout.
    const is_group_stage =
      /group/i.test(round) || date.slice(0, 10) < WC2026_GROUP_STAGE_END;
    const mdMatch = round.match(/(\d+)\s*$/);
    const matchday = mdMatch ? Number(mdMatch[1]) : GROUP_TOTAL_MATCHDAYS;
    return {
      matchday,
      date,
      opponentName,
      goals_scored,
      shots_on_target: 0, // /fixtures?ids batch carries no shot stats
      is_group_stage,
      is_dead_rubber: false,
    };
  });
}

// Normalize a TheStatsAPI all-groups standings payload into typed rows.
// The endpoint returns 12 groups of 4 (each row carries group_label A..L) PLUS
// a 12-row cross-group third-place ranking table (group_label is null, position
// is the cross-group rank). We keep the group rows for per-group settlement
// logic and derive our own third-place table from them.
interface StandingRow {
  team_id: string;
  team_name: string;
  points: number;
  position: number;
  matches_played: number;
  goal_difference: number;
  goals_for: number;
  group_label: string | null;
}
interface ThirdPlaceRow {
  team_id: string;
  team_name: string;
  group_label: string;
  points: number;
  goal_difference: number;
  goals_for: number;
}
interface AllStandings {
  groupRows: StandingRow[];
  thirdPlaceTable: ThirdPlaceRow[];
  raw: StandingRow[];
}

function normalizeStandingRows(payload: unknown): StandingRow[] {
  const arr = extractArray(
    getField(payload, ["data", "standings", "table", "rows"]) ?? payload,
  );
  return arr.map((row) => {
    const team = getField(row, ["team"]) ?? row;
    const gl = getField(row, ["group_label", "group", "label"]);
    return {
      team_id: String(
        getField(team, ["id", "team_id"]) ?? getField(row, ["team_id"]) ?? "",
      ),
      team_name: String(getField(team, ["name", "team_name"]) ?? ""),
      points: Number(getField(row, ["points", "pts"]) ?? 0) || 0,
      position:
        Number(getField(row, ["position", "rank", "place"]) ?? 0) || 0,
      matches_played:
        Number(
          getField(row, [
            "matches_played",
            "matchesPlayed",
            "played",
            "games_played",
          ]) ?? 0,
        ) || 0,
      goal_difference:
        Number(getField(row, ["goal_difference", "goalDifference", "gd"]) ?? 0) ||
        0,
      goals_for:
        Number(getField(row, ["goals_for", "goalsFor", "gf"]) ?? 0) || 0,
      group_label:
        gl === null || gl === undefined || gl === "" ? null : String(gl),
    };
  });
}

// All-groups standings — fetched ONCE and cached forever as
// "statsapi_all_standings_static" (group stage is final and immutable). This
// single call replaces the previous per-group standings calls.
let statsapiAllStandingsMem: AllStandings | null = null;
async function getStatsApiAllStandings(): Promise<AllStandings> {
  if (statsapiAllStandingsMem) return statsapiAllStandingsMem;
  if (typeof window !== "undefined") {
    const raw = window.localStorage.getItem("statsapi_all_standings_static");
    if (raw) {
      try {
        const cached = JSON.parse(raw) as AllStandings;
        if (cached?.groupRows?.length) {
          statsapiAllStandingsMem = cached;
          return cached;
        }
      } catch {
        /* refetch */
      }
    }
  }
  const payload = await saGet(
    `/football/competitions/${STATSAPI_COMPETITION_ID}/seasons/${STATSAPI_SEASON_ID}/standings`,
  );
  const all = buildAllStandings(payload);
  statsapiAllStandingsMem = all;
  if (typeof window !== "undefined" && all.groupRows.length) {
    try {
      window.localStorage.setItem(
        "statsapi_all_standings_static",
        JSON.stringify(all),
      );
    } catch {
      /* quota — in-memory only */
    }
  }
  return all;
}

// Derive group rows (group_label A..L) and the cross-group third-place table
// (position === 3 across all groups, sorted points -> goal_diff -> goals_for).
function buildAllStandings(payload: unknown): AllStandings {
  const raw = normalizeStandingRows(payload);
  const groupRows = raw.filter((r) => r.group_label !== null);
  const thirdPlaceTable: ThirdPlaceRow[] = groupRows
    .filter((r) => r.position === 3)
    .map((r) => ({
      team_id: r.team_id,
      team_name: r.team_name,
      group_label: r.group_label as string,
      points: r.points,
      goal_difference: r.goal_difference,
      goals_for: r.goals_for,
    }))
    .sort(
      (a, b) =>
        b.points - a.points ||
        b.goal_difference - a.goal_difference ||
        b.goals_for - a.goals_for,
    );
  return { groupRows, thirdPlaceTable, raw };
}

// Resolve a standings row for an opponent named in an API-Football fixture, by
// normalized case-insensitive (bidirectional contains) match across ALL groups.
function resolveOpponentStandingRow(
  opponentName: string,
  rows: StandingRow[],
): StandingRow | null {
  const o = normalize(opponentName);
  if (!o) return null;
  const hit = rows.find((s) => {
    const n = normalize(s.team_name);
    return n && (n.includes(o) || o.includes(n));
  });
  return hit ?? null;
}

// Per-team dead-rubber adjustment: parse last-5, flag dead rubbers using the
// cached all-groups standings, and produce recency-weighted adjusted averages.
interface TeamDeadRubberResult {
  adjustment: ReturnType<typeof applyDeadRubberDiscount>;
  fixtureChecks: Array<{
    opponent: string;
    matchday: number;
    is_dead_rubber: boolean;
    reason: string;
    comparison: ReturnType<typeof detectDeadRubber>["comparison"];
  }>;
  groupFixtureCount: number;
  triggered: boolean;
  reason: string;
}
async function computeTeamDeadRubber(
  c4List: unknown,
  afTeamId: number,
  all: AllStandings | null,
): Promise<TeamDeadRubberResult> {
  const last5 = parseLast5(c4List, afTeamId);
  const groupFixtures = last5.filter((f) => f.is_group_stage);

  // TRIGGER CONDITION: if no last-5 fixture falls in the group-stage window,
  // skip S6 entirely for this team — nothing to dead-rubber-check.
  if (groupFixtures.length === 0) {
    return {
      adjustment: applyDeadRubberDiscount(last5),
      fixtureChecks: [],
      groupFixtureCount: 0,
      triggered: false,
      reason:
        "NOT TRIGGERED — all last-5 fixtures are knockout stage for this team.",
    };
  }

  if (!all || all.groupRows.length === 0) {
    return {
      adjustment: applyDeadRubberDiscount(last5),
      fixtureChecks: [],
      groupFixtureCount: groupFixtures.length,
      triggered: false,
      reason:
        "Group-stage fixtures present but all-groups standings unavailable — proceeding without dead-rubber discount.",
    };
  }

  const fixtureChecks: TeamDeadRubberResult["fixtureChecks"] = [];
  for (const f of last5) {
    if (!f.is_group_stage) continue;
    const oppRow = resolveOpponentStandingRow(f.opponentName, all.groupRows);
    if (!oppRow || oppRow.group_label === null) continue;
    const opponentGroupStandings = all.groupRows.filter(
      (r) => r.group_label === oppRow.group_label,
    );
    const r = detectDeadRubber({
      fixture_matchday: f.matchday,
      fixture_date: f.date,
      opponent_team_id: oppRow.team_id,
      opponent_group_standings: opponentGroupStandings,
      all_groups_third_place_table: all.thirdPlaceTable,
      group_total_matchdays: GROUP_TOTAL_MATCHDAYS,
    });
    f.is_dead_rubber = r.is_dead_rubber;
    fixtureChecks.push({
      opponent: f.opponentName,
      matchday: f.matchday,
      is_dead_rubber: r.is_dead_rubber,
      reason: r.reason,
      comparison: r.comparison,
    });
  }

  return {
    adjustment: applyDeadRubberDiscount(last5),
    fixtureChecks,
    groupFixtureCount: groupFixtures.length,
    triggered: true,
    reason: `All-groups standings resolved — ${groupFixtures.length} group-stage fixture(s) checked against cross-group 3rd-place table.`,
  };
}


export async function collectMatchData(
  match: AnalysedMatch,
  onProgress: (p: ProgressUpdate) => void,
  opts: { debug?: boolean } = {},
): Promise<CollectionResult> {
  // API keys live server-side (APIFOOTBALL_KEY / STATSAPI_KEY) and are used by
  // the api-proxy server function. This placeholder keeps the call-site signature.
  const afKey = "";

  // When debugging, capture every raw HTTP call made by afGet / saGet.
  const localDebug: DebugEntry[] = [];
  debugSink = opts.debug ? localDebug : null;

  // TheStatsAPI match reference (id + team ids), resolved once as step S0 and
  // reused by S2A/S2B (team stats), S3 (lineups), S4 (player stats) and S5
  // (Pinnacle odds). null until resolved.
  let statsApiRef: StatsApiMatchRef | null = null;
  let statsApiResolved = false;
  const ensureStatsApiMatch = async (): Promise<StatsApiMatchRef | null> => {
    if (statsApiResolved) return statsApiRef;
    statsApiResolved = true;
    try {
      statsApiRef = await resolveStatsApiMatch(
        match.home,
        match.away,
        match.kickoffUtc,
      );
    } catch (e) {
      console.warn("[analyse] TheStatsAPI match resolution failed", e);
      statsApiRef = null;
    }
    return statsApiRef;
  };
  const ensureStatsApiMatchId = async (): Promise<string | null> =>
    (await ensureStatsApiMatch())?.id ?? null;




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
  const counterCritical = getApiCallCount() >= CRITICAL_THRESHOLD;

  // ---- STEP 1: data calls ----

  // S0: resolve the TheStatsAPI match (id + per-team ids). Everything sourced
  // from TheStatsAPI (team stats, lineups, player stats, Pinnacle) depends on
  // this. Recorded as its own debug row so the report shows S0 explicitly.
  await runStep("S0", "Resolving TheStatsAPI match (lookup)... (S0)", async () => {
    const ref = await ensureStatsApiMatch();
    if (!ref) {
      throw new Error(
        "STATSAPI_ID_NOT_FOUND — no TheStatsAPI match resolved for these teams/date.",
      );
    }
    return {
      match_id: ref.id,
      home_team: { id: ref.homeTeamId, name: ref.homeTeamName },
      away_team: { id: ref.awayTeamId, name: ref.awayTeamName },
      went_to_penalties: ref.wentToPenalties,
      penalty_shootout: ref.penaltyShootout,
    };
  });

  // S2A / S2B: team season stats from TheStatsAPI (richer WC2026 data than
  // API-Football for this tournament). Replaces the old API-Football
  // /teams/statistics calls. Team ids come from the S0 lookup response.
  await runStep("2A", "Fetching home team stats (TheStatsAPI)... (1/11)", async () => {
    const ref = await ensureStatsApiMatch();
    if (!ref?.homeTeamId) {
      throw new Error("No TheStatsAPI home_team.id available from match lookup.");
    }
    const raw = await saGet(
      `/football/teams/${ref.homeTeamId}/stats?season_id=${STATSAPI_SEASON_ID}`,
    );
    if (isEmptyResponse(raw)) throw new Error("No TheStatsAPI home team stats returned.");
    return { teamId: ref.homeTeamId, extracted: extractTeamStats(raw), raw };
  });
  await runStep("2B", "Fetching away team stats (TheStatsAPI)... (2/11)", async () => {
    const ref = await ensureStatsApiMatch();
    if (!ref?.awayTeamId) {
      throw new Error("No TheStatsAPI away_team.id available from match lookup.");
    }
    const raw = await saGet(
      `/football/teams/${ref.awayTeamId}/stats?season_id=${STATSAPI_SEASON_ID}`,
    );
    if (isEmptyResponse(raw)) throw new Error("No TheStatsAPI away team stats returned.");
    return { teamId: ref.awayTeamId, extracted: extractTeamStats(raw), raw };
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

  // 6 (S3): confirmed lineups (TheStatsAPI).
  // Reuses the S0 match_id, then fetches /football/matches/{match_id}/lineups.
  // TheStatsAPI publishes lineups at ~T-75min (earlier than API-Football's
  // ~T-20min); until then the endpoint 404s (saGet returns null). If null/empty,
  // flag LINEUP PENDING. Retry up to 3 times with 60s gaps when within 90 min.
  await runStep("6", "Fetching confirmed lineups (TheStatsAPI)... (8/11)", async () => {
    const matchId = await ensureStatsApiMatchId();
    if (!matchId) {
      throw new Error(
        "STATSAPI_ID_NOT_FOUND — no TheStatsAPI match resolved for these teams/date. Lineups unavailable.",
      );
    }
    const withinWindow = match.minutesUntilKickoff <= 90;
    const maxAttempts = withinWindow ? 3 : 1;
    let payload: unknown = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      payload = await saGet(`/football/matches/${matchId}/lineups`);
      if (!isEmptyResponse(payload)) return payload;
      if (attempt < maxAttempts - 1) await sleep(60000);
    }
    throw new Error("LINEUP PENDING — lineups not yet announced (empty/404).");
  });


  // NOTE: CALL 6B / S4 (player stats for absences) runs LAST, after the
  // mandatory Pinnacle call (S5), because TheStatsAPI enforces a tight rate
  // limit. Running the player-stat burst first would starve S5. See below.


  // 7 (S7): referee profile.
  // PRIMARY = S7: TheStatsAPI dedicated endpoint /football/matches/{id}/referee,
  // which returns CAREER TOTALS (games, yellow_cards, red_cards). We derive
  // avg_yellow_cards_per_game = yellow_cards / games from it. This single call
  // is spaced by STATSAPI_DELAY_MS inside saGet, so it sits in the sequential
  // TheStatsAPI throttle order like every other S-call.
  // fouls-per-game and penalties-per-game are NOT in the referee endpoint, so we
  // enrich those two fields (when the budget allows) from API-Football's
  // completed-fixture history. FALLBACK: if S7 returns a null referee (none
  // assigned) or fails, fall back entirely to the API-Football-derived profile.
  {
    stepKeys.push("7");
    onProgress({
      step: stepKeys.length,
      total: TOTAL_STEPS,
      label: "Fetching referee profile (S7)... (9/11)",
    });
    currentDebugCall = "7";
    try {
      let profile: RefereeProfile | null = null;

      // --- S7: TheStatsAPI dedicated referee endpoint (career totals) ---
      const matchId = await ensureStatsApiMatchId();
      if (matchId) {
        try {
          const refJson = await saGet(`/football/matches/${matchId}/referee`);
          const refNode = getField(getField(refJson, ["data"]) ?? refJson, ["referee"]);
          profile = buildRefereeProfileFromStatsApi(refNode);
        } catch (e) {
          console.warn("[analyse] S7 referee endpoint failed", e);
        }
      }

      // --- API-Football enrichment / fallback ---
      // When S7 gave us a referee, only run the (costly) API-Football history if
      // the budget allows, and use it solely to fill fouls/penalties (and yellows
      // if S7 lacked games). When S7 had no referee, use API-Football entirely.
      const afName =
        (typeof profile?.referee === "string" && profile.referee) || match.referee;
      if (afName && !counterCritical) {
        try {
          const afProfile = await buildRefereeProfile(afName, !counterWarning);
          if (afProfile) {
            if (!profile) {
              profile = afProfile; // FALLBACK: S7 null → API-Football profile.
            } else {
              profile.avg_fouls_per_game = afProfile.avg_fouls_per_game;
              profile.penalties_awarded = afProfile.penalties_awarded;
              if (profile.avg_yellow_cards_per_game === "NOT_AVAILABLE") {
                profile.avg_yellow_cards_per_game = afProfile.avg_yellow_cards_per_game;
              }
              profile.source =
                "TheStatsAPI /referee (yellows from career) + API-Football history (fouls/penalties)";
            }
          }
        } catch (e) {
          console.warn("[analyse] CALL 7 API-Football referee enrichment failed", e);
        }
      }

      if (profile) {
        record("7", "Referee profile (S7 + API-Football)", "SUCCESS", profile);
      } else {
        record(
          "7",
          "Referee profile",
          "EMPTY",
          undefined,
          `Referee strictness: UNKNOWN. S7 returned no referee and no API-Football fixtures matched "${
            match.referee ?? "unknown"
          }" — cards market estimates use historical base rate only.`,
        );
      }
    } catch (e) {
      record(
        "7",
        "Referee profile",
        "EMPTY",
        undefined,
        `Referee strictness: UNKNOWN. Referee profile unavailable — cards market estimates use historical base rate only. (${
          e instanceof Error ? e.message : String(e)
        })`,
      );
    } finally {
      currentDebugCall = null;
    }
  }


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

  // 9: odds (Stake via API-Football only)
  await runStep("9", "Fetching odds... (11/11)", async () => {
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
    return { stakeOdds: afOdds };
  });

  // CALL 9B: TheStatsAPI Pinnacle odds + line movement.
  // Reuses the TheStatsAPI match_id resolved for CALL 6. Fetches
  // /football/matches/{match_id}/odds, filters for Pinnacle, and extracts
  // opening + last_seen per market (1X2, over/under, BTTS, corners) with line
  // movement. On any failure or no Pinnacle data -> EMPTY.
  {
    stepKeys.push("9B");
    onProgress({
      step: stepKeys.length,
      total: TOTAL_STEPS,
      label: "Fetching Pinnacle odds (TheStatsAPI)...",
    });
    currentDebugCall = "9B";
    // Spacing between TheStatsAPI calls is handled centrally in saGet
    // (STATSAPI_DELAY_MS); no extra burst cool-down needed here.
    try {
      // Diagnostic: the real key lives server-side as the STATSAPI_KEY secret
      // (used by the api-proxy). VITE_STATSAPI_KEY is optional documentation only.
      console.log(
        "TheStatsAPI key prefix (browser, optional):",
        import.meta.env.VITE_STATSAPI_KEY?.slice(0, 4) ?? "(not set — using server STATSAPI_KEY)",
      );
      const matchId = await ensureStatsApiMatchId();

      if (!matchId) {
        record(
          "9B",
          "Pinnacle odds (TheStatsAPI)",
          "EMPTY",
          undefined,
          "Pinnacle data unavailable — no TheStatsAPI match matched this fixture.",
        );
      } else {
        const oddsJson = await saGet(`/football/matches/${matchId}/odds`);
        const summary = buildPinnacleSummary(oddsJson);

        if (!summary) {
          record(
            "9B",
            "Pinnacle odds (TheStatsAPI)",
            "EMPTY",
            { matchId },
            "Pinnacle/odds data unavailable — no bookmaker markets returned for this match.",
          );
        } else {
          // Gap check vs Stake (best-effort on 1X2).
          const stakeRoot = callResults["9"]?.data as { stakeOdds?: unknown } | undefined;
          const gapCheck = buildStakeGapCheck(stakeRoot?.stakeOdds, summary.markets);

          record("9B", "Pinnacle odds (TheStatsAPI)", "SUCCESS", {
            matchId,
            bookmaker: summary.bookmaker,
            markets: summary.markets,
            gap_check: gapCheck,
            note:
              `Odds source bookmaker: ${summary.bookmaker}. ` +
              (normalize(summary.bookmaker).includes("pinnacle")
                ? ""
                : "Pinnacle not offered for this match; line-movement/sharp-money signals from this non-Pinnacle book are weaker — weight accordingly. ") +
              "movement_pct = (last_seen - opening) / opening * 100. opening may be null (only last_seen captured) → movement UNKNOWN. SHARP MOVE = shortened >8% (confidence +5 if model agrees, -5 if model opposes). DRIFT = drifted >8% (confidence -3). STABLE = <5% either way (no impact). BORDERLINE = 5-8%.",
          });
        }
      }
    } catch (e) {
      record(
        "9B",
        "Pinnacle odds (TheStatsAPI)",
        "EMPTY",
        undefined,
        `Pinnacle data unavailable — ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      currentDebugCall = null;
    }
  }

  // ---- S6: dead-rubber detection (group-stage games in last-5 form) ----
  // Runs AFTER CALL 4 (recent form) using the already-fetched last-5 lists, and
  // BEFORE the optional CALL 6B player-stat burst so the mandatory all-groups
  // standings call always gets TheStatsAPI rate-limit budget first.
  // Triggers ONLY when a last-5 fixture falls in the group-stage window; when it
  // fires, it makes exactly ONE new call (all-groups standings, cached once).
  // WC2026-aware: uses the cross-group 3rd-place table so a 3rd-placed team that
  // could still advance as a best-third finisher is NOT mis-flagged.
  let deadRubberTriggered = false;
  let deadRubberFlagged = 0;
  {
    currentDebugCall = "S6";
    onProgress({
      step: stepKeys.length,
      total: TOTAL_STEPS,
      label: "Checking for dead-rubber group games (TheStatsAPI)...",
    });
    try {
      const homeList = callResults["4-1"]?.data ?? null;
      const awayList = callResults["4-2"]?.data ?? null;

      // Decide whether the single all-groups standings call is needed at all.
      const homeNeeds = parseLast5(homeList, match.homeId).some(
        (f) => f.is_group_stage,
      );
      const awayNeeds = parseLast5(awayList, match.awayId).some(
        (f) => f.is_group_stage,
      );

      let all: AllStandings | null = null;
      if (homeNeeds || awayNeeds) {
        all = await getStatsApiAllStandings();
      }

      const homeDr = await computeTeamDeadRubber(homeList, match.homeId, all);
      const awayDr = await computeTeamDeadRubber(awayList, match.awayId, all);

      deadRubberFlagged =
        homeDr.adjustment.dead_rubber_count +
        awayDr.adjustment.dead_rubber_count;
      deadRubberTriggered = homeDr.triggered || awayDr.triggered;

      // Adjusted averages injected into the [CALL 4] block sent to Claude.
      callResults["4-deadrubber"] = {
        key: "4-deadrubber",
        label: "Recency-weighted & dead-rubber-adjusted form",
        status: "SUCCESS",
        data: {
          home: {
            team: match.home,
            adjusted_goals_avg: homeDr.adjustment.adjusted_goals_avg,
            adjusted_shots_avg: homeDr.adjustment.adjusted_shots_avg,
            dead_rubber_count: homeDr.adjustment.dead_rubber_count,
            note: homeDr.adjustment.note,
          },
          away: {
            team: match.away,
            adjusted_goals_avg: awayDr.adjustment.adjusted_goals_avg,
            adjusted_shots_avg: awayDr.adjustment.adjusted_shots_avg,
            dead_rubber_count: awayDr.adjustment.dead_rubber_count,
            note: awayDr.adjustment.note,
          },
          dead_rubber_count: deadRubberFlagged,
        },
      };

      if (!deadRubberTriggered) {
        record(
          "S6",
          "All-groups standings (3rd-place-aware dead-rubber check)",
          "SKIPPED",
          undefined,
          "NOT TRIGGERED — all last-5 fixtures are knockout stage for both teams.",
        );
      } else {
        record(
          "S6",
          "All-groups standings (3rd-place-aware dead-rubber check)",
          all && all.groupRows.length ? "SUCCESS" : "EMPTY",
          {
            wc2026_qualification: WC2026_QUALIFICATION,
            all_groups_standings: all?.groupRows ?? [],
            cross_group_third_place_table: (all?.thirdPlaceTable ?? []).map(
              (t, i) => ({
                rank: i + 1,
                advances: i < WC2026_QUALIFICATION.best_third_place_advancing,
                ...t,
              }),
            ),
            home: {
              group_fixtures_in_last5: homeDr.groupFixtureCount,
              dead_rubbers_flagged: homeDr.adjustment.dead_rubber_count,
              reason: homeDr.reason,
              fixture_checks: homeDr.fixtureChecks,
            },
            away: {
              group_fixtures_in_last5: awayDr.groupFixtureCount,
              dead_rubbers_flagged: awayDr.adjustment.dead_rubber_count,
              reason: awayDr.reason,
              fixture_checks: awayDr.fixtureChecks,
            },
          },
        );
      }
    } catch (e) {
      record(
        "S6",
        "All-groups standings (3rd-place-aware dead-rubber check)",
        "EMPTY",
        undefined,
        `Dead-rubber check unavailable — ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      currentDebugCall = null;
    }
  }


  // CALL 6B (S4): player stats for absences (TheStatsAPI). Runs AFTER S5 so the
  // mandatory Pinnacle call gets rate-limit budget first. Triggers ONLY when
  // CALL 5 (injuries) returned absences. Player ids come from the S3 lineup
  // starting_xi. Best-effort: a per-call failure stops the loop but keeps any
  // results already gathered. Recorded directly (not a numbered progress step).
  {
    currentDebugCall = "6B";
    onProgress({
      step: stepKeys.length,
      total: TOTAL_STEPS,
      label: "Fetching player stats (TheStatsAPI)...",
    });
    const injuries = callResults["5"];
    const injuryItems =
      injuries?.status === "SUCCESS" ? extractArray(injuries.data) : [];
    const hasAbsences = injuryItems.length > 0;

    const lineupResult = callResults["6"];
    const playerIds =
      lineupResult?.status === "SUCCESS"
        ? extractLineupPlayerIds(lineupResult.data)
        : [];

    if (!hasAbsences) {
      record(
        "6B",
        "Player stats (TheStatsAPI)",
        "SKIPPED",
        undefined,
        "No absences in CALL 5 — player stats not triggered.",
      );
    } else if (playerIds.length === 0) {
      record(
        "6B",
        "Player stats (TheStatsAPI)",
        "EMPTY",
        undefined,
        "Absences present but no starting_xi player ids available from lineups.",
      );
    } else {
      // Cap to keep the run bounded and throttle hard — TheStatsAPI enforces a
      // tight burst rate limit, so we keep this optional player-stat burst small
      // (it runs LAST, after the mandatory S5/S6 calls have taken their budget).
      const ids = playerIds.slice(0, 4);
      const perPlayer: Record<string, unknown> = {};
      let lastError: string | undefined;
      // Each player call is spaced by STATSAPI_DELAY_MS inside saGet, so the
      // loop runs sequentially with the standard gap between calls.
      for (const pid of ids) {
        try {
          const raw = await saGet(
            `/football/players/${pid}/stats?season_id=${STATSAPI_SEASON_ID}&competition_id=${STATSAPI_COMPETITION_ID}`,
          );
          if (!isEmptyResponse(raw)) {
            perPlayer[pid] = extractPlayerStats(raw);
          }
        } catch (e) {
          lastError = e instanceof Error ? e.message : String(e);
          break; // stop on rate-limit / error; keep what we have
        }
      }
      const anyData = Object.keys(perPlayer).length > 0;
      record(
        "6B",
        "Player stats (TheStatsAPI)",
        anyData ? "SUCCESS" : "EMPTY",
        anyData
          ? { playerCount: Object.keys(perPlayer).length, playerStatistics: perPlayer }
          : undefined,
        anyData
          ? undefined
          : lastError ?? "No player statistics returned for the starting XI.",
      );
    }
    currentDebugCall = null;
  }






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
      if (isEmptyResponse(r)) {
        record(
          "10",
          "Next-round bracket",
          "EXPECTED_EMPTY",
          r,
          `Next round (${nr}) fixtures not yet determined. Bracket context unavailable.`,
        );
      } else {
        record("10", "Next-round bracket", "SUCCESS", r);
      }

    } catch (e) {
      record("10", "Next-round bracket", "FAILED", undefined,
        e instanceof Error ? e.message : String(e));
    } finally {
      currentDebugCall = null;
    }
  }

  // (S6 dead-rubber detection now runs earlier — before the optional CALL 6B
  // player-stat burst — so the mandatory all-groups standings call is not
  // starved of TheStatsAPI rate-limit budget. See the S6 block above.)

  // ---- Round of 32 historical base-rate staleness flag (system-prompt rule
  // 33). Only the structural precondition (round === Round of 32) is knowable
  // at pipeline time; Claude evaluates conditions (a)/(b) on signal alignment.
  const roundLabel = (match.round ?? "").toLowerCase();
  const isRoundOf32 =
    /round of 32/.test(roundLabel) || /\br32\b/.test(roundLabel);
  const historicalCaveatEligible = isRoundOf32;
  const historicalCaveatReason = isRoundOf32
    ? "ELIGIBLE — match is Round of 32; rule 33 caveat applies if ensemble alignment is CONFLICT/MAJORITY and signal_3_historical is the outlier or materially drives the recommendation."
    : `NOT ELIGIBLE — round is "${match.round ?? "unknown"}"; Round of 16+ existed in the pre-2026 format so historical base rates remain structurally comparable.`;



  const succeeded = stepKeys.filter(
    (k) => callResults[k]?.status === "SUCCESS",
  ).length;
  const failedCalls = stepKeys.filter(
    (k) => callResults[k] && callResults[k].status !== "SUCCESS",
  );
  const emptyOrFailed = failedCalls.length;

  const lineupResolved = callResults["6"]?.status === "SUCCESS";

  // Detach the debug sink so later non-debug runs are not recorded into it.
  debugSink = null;

  return {
    callResults,
    lineupResolved,
    succeeded,
    emptyOrFailed,
    failedCalls,
    warning: lineupResolved
      ? null
      : "⚠️ Confirmed lineups unavailable (LINEUP PENDING). TheStatsAPI publishes lineups at ~T-75min before kickoff — analysis will proceed with reduced data.",
    counterWarning,
    debugEntries: opts.debug ? localDebug : undefined,
    deadRubberTriggered,
    deadRubberFlagged,
    historicalCaveatEligible,
    historicalCaveatReason,

  };
}

/**
 * Re-fetch CALL 6 (confirmed lineups) for a single fixture. Used to
 * auto-refresh lineups once the lineup-drop time passes when an earlier run
 * came back LINEUP PENDING. Resolves TheStatsAPI's match_id by team name on the
 * kickoff date, then fetches /football/matches/{match_id}/lineups. Returns a
 * CallResult that callers can merge into an existing callResults object.
 */
export async function refetchLineups(match: AnalysedMatch): Promise<CallResult> {
  try {
    const matchId = await resolveStatsApiMatchId(
      match.home,
      match.away,
      match.kickoffUtc,
    );
    if (!matchId) {
      return {
        key: "6",
        label: "Confirmed lineups",
        status: "EMPTY",
        error:
          "STATSAPI_ID_NOT_FOUND — no TheStatsAPI match resolved for these teams/date.",
      };
    }
    const payload = await saGet(`/football/matches/${matchId}/lineups`);
    if (isEmptyResponse(payload)) {
      return {
        key: "6",
        label: "Confirmed lineups",
        status: "EMPTY",
        error: "LINEUP PENDING — lineups not yet announced (empty/404).",
      };
    }
    return {
      key: "6",
      label: "Confirmed lineups",
      status: "SUCCESS",
      data: replaceNulls(payload),
    };
  } catch (e) {
    return {
      key: "6",
      label: "Confirmed lineups",
      status: "FAILED",
      error: e instanceof Error ? e.message : String(e),
    };
  }
}


// DEBUG MODE — resolve a fixed real fixture for testing the full pipeline.
// Germany vs Paraguay (2026-06-29, Round of 32). Fetches the real fixture from
// API-Football for that date so collectMatchData can run against live data.
// Fixture/match IDs are NOT hardcoded — resolved via the same C1 (API-Football)
// and S0 (TheStatsAPI) lookup path used for any normal match.
// ============================================================================

export const DEBUG_FIXTURE_DATE = "2026-06-29";
const DEBUG_TEAM_A = "germany";
const DEBUG_TEAM_B = "paraguay";

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
  const response = await afGet(
    `/fixtures?league=1&season=2026&date=${DEBUG_FIXTURE_DATE}`,
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
      `Debug fixture "Germany vs Paraguay" not found in API-Football for ${DEBUG_FIXTURE_DATE}.`,
    );
  }

  const kickoffUtc = item.fixture.date ?? `${DEBUG_FIXTURE_DATE}T00:00:00Z`;
  const minutesUntilKickoff = Math.round(
    (new Date(kickoffUtc).getTime() - Date.now()) / 60000,
  );

  return {
    id: item.fixture.id,
    home: item.teams.home.name ?? "Germany",
    away: item.teams.away.name ?? "Paraguay",
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
