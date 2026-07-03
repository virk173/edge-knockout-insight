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
  WARNING_THRESHOLD,
  CRITICAL_THRESHOLD,
} from "./apiCounter";
import { apiFootballGet } from "./apiFootball";
import { readCallCache, writeCallCache } from "./callCache";
import { writeClosingCapture, type ClosingCapture } from "./clv";

/*
 * KNOWN GAPS — documented, not bugs
 *
 * GAP 1: Pipeline test coverage
 * analyse.ts has no automated test suite. collectMatchData(),
 * formatDataForClaude(), and the per-call retry/cache logic are verified
 * manually via Debug Mode live runs only. Adding Vitest coverage here (with
 * mocked API responses) is the next hardening priority before scaling stakes.
 *
 * GAP 2: Pinnacle odds unverified live
 * All WC2026 matches tested to date have returned Bet365 from TheStatsAPI,
 * not Pinnacle. The Pinnacle extraction path in S5 (buildPinnacleSummary, line
 * movement calculation, adjustEVForPinnacleGap) is correctly implemented but
 * has never been exercised with real Pinnacle data. ev_confidence is correctly
 * set to MEDIUM when Pinnacle is absent.
 *
 * GAP 3: Opponent-strength normalization
 * Gap Score in calculate.ts weights a player's actual_goals and actual_assists
 * from tournament stats without adjusting for opponent quality. A goal scored
 * against a weak group-stage opponent receives the same weight as one scored
 * against an elite side. This is a known bias (Bias #1) that was deliberately
 * not fixed due to data availability constraints — opponent quality index is
 * not available from either API.
 */


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



export type CallStatus =
  | "SUCCESS"
  | "EMPTY"
  | "EXPECTED_EMPTY"
  | "FAILED"
  | "SKIPPED"
  // Dependent call was refused because the C1 fixture-id verification failed
  // (resolved fixture belongs to a different match). Never runs the HTTP call.
  | "BLOCKED";

export interface CallResult {
  key: string;
  label: string;
  status: CallStatus;
  data?: unknown;
  error?: string;
  // True when this result was loaded from the persistent per-call cache rather
  // than freshly fetched during this run. Drives the "CACHED" panel badge.
  cached?: boolean;
  // Epoch ms the underlying data was fetched (from cache metadata or now()).
  fetchedAt?: number;
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
  // Three-state lineup classification for this run + whether the XI was resolved
  // (from TheStatsAPI or the API-Football fallback).
  lineupState: LineupState;
  lineupResolved: boolean;
}


export interface CollectionResult {
  callResults: Record<string, CallResult>;
  lineupResolved: boolean;
  // Three-state lineup classification (NOT_ANNOUNCED / PROPAGATING / POPULATED).
  lineupState: LineupState;
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

// Last observed lineup state from CALL 6 (S3) of the current run. Read when
// building the CollectionResult so the warning + confidence penalty can
// distinguish "not yet announced" from "announced but propagating".
let lastLineupState: LineupState = "NOT_ANNOUNCED";


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
  { key: "9B", n: "9B", endpoint: "/odds?bookmaker=4 (Pinnacle price levels, API-Football)" },
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
    "9A": () => d.markets !== undefined || resp !== undefined,
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
 * Compact last-5 scoreline summary for a team's recent-form list (CALL 4-1 /
 * 4-2). We ship THIS instead of the raw /fixtures/statistics batch (CALL 4-3),
 * which alone was ~85k tokens and pushed the prompt past Claude's 200k context
 * limit — the true cause of the "timeout / Job expired" failures. The detailed
 * shot stats in 4-3 are already distilled into the dead-rubber-adjusted
 * averages appended below, so the raw batch is redundant.
 */
function extractLast5Scorelines(list: unknown): string[] {
  return scorelinesFrom(list, 5);
}

// Generic scoreline summariser used for CALL 4 (last 5) and CALL 3 (h2h, up to
// 10). Turns a raw API-Football fixtures array into compact one-line strings so
// we never ship the full ~1.5KB-per-fixture objects (logos, venue, timestamps,
// periods) to Claude — none of which it uses.
function scorelinesFrom(list: unknown, limit: number): string[] {
  return extractArray(list)
    .slice(0, limit)
    .map((item) => {
      const fx = getField(item, ["fixture"]);
      const date = String(getField(fx, ["date"]) ?? "").slice(0, 10);
      const round = String(getField(getField(item, ["league"]), ["round"]) ?? "");
      const teams = getField(item, ["teams"]);
      const hn = String(getField(getField(teams, ["home"]), ["name"]) ?? "?");
      const an = String(getField(getField(teams, ["away"]), ["name"]) ?? "?");
      const goals = getField(item, ["goals"]);
      const hg = getField(goals, ["home"]);
      const ag = getField(goals, ["away"]);
      const score = `${hg ?? "-"}-${ag ?? "-"}`;
      return `${date} ${hn} ${score} ${an}${round ? ` (${round})` : ""}`;
    });
}

// ---- Per-block compactors (Claude-facing only) ----------------------------
// These trim the RAW stored responses down to just the fields Claude actually
// reads before they are JSON.stringify'd into the prompt. They run ONLY inside
// formatDataForClaude — the full raw responses stay in callResults / the cache
// so pipeline logic (dead-rubber, lineup player-id extraction, gap check) is
// unaffected. Measured savings: CALL 8 ~5000→~350 tok, CALL 6 ~3700→~700 tok,
// CALL 3 ~3600→~250 tok, CALL 5 ~1300→~250 tok, CALL 2A/2B drop raw blob.

function compactPlayer(p: unknown): { name: unknown; pos: unknown; num: unknown } {
  const pl = getField(p, ["player"]) ?? p;
  return {
    name: getField(pl, ["name"]) ?? null,
    pos: getField(pl, ["position", "pos"]) ?? null,
    num: getField(pl, ["jersey_number", "number"]) ?? null,
  };
}

function compactLineupSide(side: unknown): Record<string, unknown> {
  return {
    team: getField(side, ["team_name", "name"]) ?? getField(getField(side, ["team"]), ["name"]) ?? null,
    formation: getField(side, ["formation"]) ?? null,
    starting_xi: extractArray(getField(side, ["starting_xi", "startXI", "startingXi", "startingXI"])).map(compactPlayer),
    substitutes: extractArray(getField(side, ["substitutes"])).map((p) => compactPlayer(p).name),
  };
}

function compactLineup(data: unknown): Record<string, unknown> {
  const node = getField(data, ["data"]) ?? data;
  const home = getField(node, ["home"]);
  const away = getField(node, ["away"]);
  if (home || away) {
    return {
      confirmed: getField(node, ["confirmed"]) ?? null,
      source: getField(node, ["source"]) ?? null,
      home: home ? compactLineupSide(home) : null,
      away: away ? compactLineupSide(away) : null,
    };
  }
  return { sides: extractArray(node).map(compactLineupSide) };
}

function compactPredictions(data: unknown): Record<string, unknown> {
  const first = (extractArray(data)[0] ?? data) as unknown;
  const predictions = getField(first, ["predictions"]);
  const teams = getField(first, ["teams"]);
  const formOf = (t: unknown) => {
    const l5 = getField(t, ["last_5"]);
    const goals = getField(l5, ["goals"]);
    return {
      form: getField(getField(t, ["league"]), ["form"]) ?? getField(l5, ["form"]) ?? null,
      att: getField(l5, ["att"]) ?? null,
      def: getField(l5, ["def"]) ?? null,
      goals_for_avg: getField(getField(goals, ["for"]), ["average"]) ?? null,
      goals_against_avg: getField(getField(goals, ["against"]), ["average"]) ?? null,
    };
  };
  return {
    predictions: predictions
      ? {
          winner: getField(getField(predictions, ["winner"]), ["name"]) ?? null,
          advice: getField(predictions, ["advice"]) ?? null,
          percent: getField(predictions, ["percent"]) ?? null,
          under_over: getField(predictions, ["under_over"]) ?? null,
          goals: getField(predictions, ["goals"]) ?? null,
        }
      : null,
    comparison: getField(first, ["comparison"]) ?? null,
    home_form: teams ? formOf(getField(teams, ["home"])) : null,
    away_form: teams ? formOf(getField(teams, ["away"])) : null,
    // NOTE: the embedded h2h array (dup of CALL 3, ~2000 tokens) is dropped.
  };
}

function compactInjuries(data: unknown): Array<Record<string, unknown>> {
  return extractArray(data).map((it) => {
    const player = getField(it, ["player"]);
    return {
      player: getField(player, ["name"]) ?? null,
      team: getField(getField(it, ["team"]), ["name"]) ?? null,
      type: getField(player, ["type"]) ?? null,
      reason: getField(player, ["reason"]) ?? null,
    };
  });
}

// FIX 3a — map a TheStatsAPI /football/teams/{id}/injuries-suspensions payload
// into the CALL 5 (API-Football /injuries) compact shape the compactor reads
// (player.name, team.name, player.type, player.reason) plus active +
// expected_return. Only active=true records are returned, so they count as
// genuine absences for the CALL 6B trigger.
// TODO: injuries-suspensions returns player_id only (no player name). A squad
// lookup (GET /football/teams/{id}/players) could resolve names — deferred.
function mapStatsApiInjuries(
  payload: unknown,
  teamName: string | null,
): Array<Record<string, unknown>> {
  const node = getField(payload, ["data"]) ?? payload;
  const out: Array<Record<string, unknown>> = [];
  const push = (rec: unknown, kind: "injury" | "suspension") => {
    if (getField(rec, ["active"]) !== true) return; // only active absences count
    const pid = getField(rec, ["player_id"]);
    out.push({
      player: {
        name:
          getField(rec, ["player_name", "name"]) ??
          (pid != null ? String(pid) : null),
        type:
          kind === "suspension"
            ? "Suspension"
            : (getField(rec, ["status"]) ?? "Injury"),
        reason: getField(rec, ["reason"]) ?? null,
      },
      team: { name: teamName },
      active: true,
      expected_return:
        getField(rec, ["expected_return"]) ?? getField(rec, ["end_date"]) ?? null,
      source: "TheStatsAPI injuries-suspensions fallback",
    });
  };
  for (const inj of extractArray(getField(node, ["injuries"]))) push(inj, "injury");
  for (const sus of extractArray(getField(node, ["suspensions"])))
    push(sus, "suspension");
  return out;
}

// FIX 3b — map TheStatsAPI /football/matches rows into the API-Football fixture
// shape scorelinesFrom() understands (fixture.date, league.round, teams, goals),
// so the existing CALL 3 compactor + H2H gate work unchanged. Filters to rows
// where the OTHER side matches the away team (contains-style, like
// resolveOpponentStandingRow), newest first, capped at 10.
// TODO: real post-match xG lives at /football/matches/{id}/player-stats (settles
// 1-2h after FT; live returns 409) — not fetched in this build.
function statsApiMatchesToFixtures(
  payload: unknown,
  awayTeamName: string,
): Array<Record<string, unknown>> {
  const rows = extractArray(getField(payload, ["data"]) ?? payload);
  const oppo = normalize(awayTeamName);
  return rows
    .filter((mt) => {
      const hn = normalize(
        String(getField(getField(mt, ["home_team"]), ["name"]) ?? ""),
      );
      const an = normalize(
        String(getField(getField(mt, ["away_team"]), ["name"]) ?? ""),
      );
      return (
        (!!hn && (hn.includes(oppo) || oppo.includes(hn))) ||
        (!!an && (an.includes(oppo) || oppo.includes(an)))
      );
    })
    .sort((a, b) => {
      const da = String(getField(a, ["utc_date"]) ?? "");
      const db = String(getField(b, ["utc_date"]) ?? "");
      return db.localeCompare(da); // newest first
    })
    .slice(0, 10)
    .map((mt) => {
      const score = getField(mt, ["score"]);
      return {
        fixture: { date: getField(mt, ["utc_date"]) ?? null },
        league: { round: getField(mt, ["stage_name"]) ?? null },
        teams: {
          home: { name: getField(getField(mt, ["home_team"]), ["name"]) ?? null },
          away: { name: getField(getField(mt, ["away_team"]), ["name"]) ?? null },
        },
        goals: {
          home: getField(score, ["home"]) ?? null,
          away: getField(score, ["away"]) ?? null,
        },
      };
    });
}

// Maps a validated raw response to the compact Claude-facing shape. Calls not
// listed here (7, 9A, 9B, 10) are already small and pass through unchanged.
function compactForClaude(n: string, data: unknown): unknown {
  switch (n) {
    case "2A":
    case "2B": {
      // Drop the raw team-stats blob; ship only the extracted summary fields.
      const d = data as { extracted?: unknown } | null;
      return d && d.extracted ? d.extracted : data;
    }
    case "3":
      return { last_meetings: scorelinesFrom(data, 10) };
    case "5":
      return compactInjuries(data);
    case "6":
      return compactLineup(data);
    case "8":
      return compactPredictions(data);
    default:
      return data;
  }
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
  // Synthesize 9A (Stake odds) from the combined "9" call. We ship ONLY the
  // trimmed 5-market extract, never the raw ~160-market odds blob (which alone
  // pushed a run past 200k input tokens and caused Claude 524 timeouts).
  if (combinedOdds) {
    const trimmed = extractStakeMarkets(oddsData?.stakeOdds ?? null);
    resolved["9A"] = {
      status: trimmed === null || combinedOdds.status !== "SUCCESS" ? "EMPTY" : "SUCCESS",
      data: trimmed,
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
    // CALL 4: ship the COMPACT last-5 scoreline summary (from 4-1/4-2) plus the
    // dead-rubber-adjusted averages — NOT the raw ~85k-token /fixtures/statistics
    // batch (4-3), which blew past Claude's 200k context limit.
    if (n === "4") {
      const homeLines = extractLast5Scorelines(safeResults["4-1"]?.data);
      const awayLines = extractLast5Scorelines(safeResults["4-2"]?.data);
      if (homeLines.length || awayLines.length) {
        blocks.push(
          `[CALL 4 — recent form (last 5) — SUCCESS]\n` +
            `HOME last 5 (most recent first):\n${homeLines.join("\n") || "none"}\n\n` +
            `AWAY last 5 (most recent first):\n${awayLines.join("\n") || "none"}` +
            `${deadRubberSuffix("4")}\n[END CALL 4]`,
        );
      } else {
        blocks.push(
          `[CALL 4 — recent form — EMPTY]\nNo recent form data available.${deadRubberSuffix("4")}\n[END CALL 4]`,
        );
      }
      continue;
    }
    // Validate the response shape before feeding it to Claude. validateCall
    // returns null for structurally invalid responses.
    const validated =
      r && r.status === "SUCCESS" && r.data !== null
        ? validateCall(n, r.data)
        : null;
    const hasData = validated !== null && !isEmptyResponse(validated);
    if (hasData) {
      // CALL 9B is now Pinnacle-or-empty (sourced from API-Football bookmaker=4).
      // The header states the real source so Claude treats these as genuine
      // sharp Pinnacle price levels — and flags that no line-movement history
      // exists for this competition (opening/movement are null, not zero).
      let header = endpoint;
      if (n === "9B" && validated && typeof validated === "object") {
        header =
          "Pinnacle odds (API-Football bookmaker=4) — current price levels only, NO line-movement history (opening/movement null = no data, not zero)";
      }
      // Ship the COMPACT Claude-facing shape (raw stays in callResults/cache).
      const shipped = compactForClaude(n, validated);
      blocks.push(
        `[CALL ${n} — ${header} — SUCCESS]\n${JSON.stringify(shipped, null, 2)}${deadRubberSuffix(n)}\n[END CALL ${n}]`,
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
    // (CALL 9B / Pinnacle odds is now sourced from API-Football bookmaker=4 —
    // moved to the API-Football group below.)
    { callLabel: "S6", api: "TheStatsAPI", endpoint: "/standings (all groups, 3rd-place-aware dead-rubber check)", entryKey: "S6", extracted: cr["S6"]?.status === "SUCCESS", count: false },
    { callLabel: "S7", api: "TheStatsAPI", endpoint: "/matches/{id}/referee (career totals) + API-Football fouls/penalties enrichment", entryKey: "7", extracted: cr["7"]?.status === "SUCCESS", count: true },
    // ---- API-Football group ----
    { callLabel: "CALL 3", api: "API-Football", endpoint: "/fixtures/headtohead", entryKey: "3", extracted: cr["3"]?.status === "SUCCESS", count: true },
    { callLabel: "CALL 4-1", api: "API-Football", endpoint: "/fixtures (home last 5)", entryKey: "4-1", extracted: cr["4-1"]?.status === "SUCCESS", count: true },
    { callLabel: "CALL 4-2", api: "API-Football", endpoint: "/fixtures (away last 5)", entryKey: "4-2", extracted: cr["4-2"]?.status === "SUCCESS", count: true },
    { callLabel: "CALL 4-3", api: "API-Football", endpoint: "/fixtures (last-5 ids batch)", entryKey: "4-3", extracted: cr["4-3"]?.status === "SUCCESS", count: true },
    { callLabel: "CALL 5", api: "API-Football", endpoint: "/injuries", entryKey: "5", extracted: cr["5"]?.status === "SUCCESS", count: true },
    
    { callLabel: "CALL 8", api: "API-Football", endpoint: "/predictions", entryKey: "8", extracted: cr["8"]?.status === "SUCCESS", count: true },
    { callLabel: "CALL 9A", api: "API-Football", endpoint: "/odds (Stake)", entryKey: "9A", extracted: hasUsableData(odds?.stakeOdds), count: true },
    { callLabel: "CALL 9B", api: "API-Football", endpoint: "/odds?bookmaker=4 (Pinnacle price levels)", entryKey: "9B", extracted: cr["9B"]?.status === "SUCCESS", count: true },
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
    lineupState: result.lineupState ?? "NOT_ANNOUNCED",
    lineupResolved: result.lineupResolved ?? false,
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

// API-Football GET (via server proxy). Increments the daily counter on a
// successful HTTP response. The `_key` arg is retained for call-site
// compatibility but is unused — the key lives server-side.
async function afGet(path: string, _key?: string): Promise<unknown> {
  const label = currentDebugCall ?? undefined;
  return apiFootballGet(path, {
    callLabel: label,
    onDebug: (entry) => {
      debugSink?.push({ ...entry, callLabel: label });
    },
  });
}

// ---------------------------------------------------------------------------
// FIXTURE ID VERIFICATION (C1 guard)
//
// The pipeline (C3/C4/C5/C7/C8/C9A/C10) trusts `match.id` — the API-Football
// fixture id resolved by the C1 fixtures list. If that id ever points at the
// wrong game (e.g. 1565177 France instead of 1567306 Mexico vs Ecuador), every
// dependent call succeeds but returns data for the WRONG match, silently
// corrupting the analysis. This guard re-fetches the fixture by id and confirms
// the returned team names match the teams we intend to analyse.
// ---------------------------------------------------------------------------

export interface FixtureVerification {
  verified: boolean;
  reason: string;
  expectedHome: string;
  expectedAway: string;
  actualHome: string | null;
  actualAway: string | null;
  fixtureId: number;
}

// Loose name match: either side contains the other (case-insensitive), so
// "USA" vs "United States"-style aliases and punctuation differences still pass.
function teamNameMatches(actual: string | null, expected: string): boolean {
  if (!actual || !expected) return false;
  const a = actual.toLowerCase().trim();
  const e = expected.toLowerCase().trim();
  return a === e || a.includes(e) || e.includes(a);
}

// Fetch the fixture by its resolved id and confirm the teams match. `fetcher`
// lets tests inject a fixture object without hitting the network.
export async function verifyFixtureById(
  match: Pick<AnalysedMatch, "id" | "home" | "away">,
  fetcher: (id: number) => Promise<unknown> = (id) =>
    afGet(`/fixtures?id=${id}`),
): Promise<FixtureVerification> {
  const raw = await fetcher(match.id);
  const item = extractArray(raw)[0] ?? (raw as unknown);
  const teams = getField(item, ["teams"]);
  const actualHome = (getField(getField(teams, ["home"]), ["name"]) ?? null) as
    | string
    | null;
  const actualAway = (getField(getField(teams, ["away"]), ["name"]) ?? null) as
    | string
    | null;

  return verifyFixture(match, actualHome, actualAway);
}

// Pure comparison — exported so both the pipeline and the UI can reuse it and
// so it can be unit-tested with a wrong fixture id.
export function verifyFixture(
  match: Pick<AnalysedMatch, "id" | "home" | "away">,
  actualHome: string | null,
  actualAway: string | null,
): FixtureVerification {
  const homeOk = teamNameMatches(actualHome, match.home);
  const awayOk = teamNameMatches(actualAway, match.away);
  const base = {
    expectedHome: match.home,
    expectedAway: match.away,
    actualHome,
    actualAway,
    fixtureId: match.id,
  };
  if (homeOk && awayOk) {
    return { ...base, verified: true, reason: "Teams confirmed ✓" };
  }
  if (actualHome === null && actualAway === null) {
    // Could not read teams from the fixture response — inconclusive, not a hard
    // mismatch. The caller decides whether to proceed with a caveat.
    return {
      ...base,
      verified: false,
      reason: "INCONCLUSIVE — could not read teams from fixture response.",
    };
  }
  return {
    ...base,
    verified: false,
    reason: `ID mismatch: fixture ${match.id} has ${actualHome ?? "?"} vs ${
      actualAway ?? "?"
    }, expected ${match.home} vs ${match.away}.`,
  };
}

// TheStatsAPI GET (via server proxy). The server attaches the Bearer token.
//
// Throttling contract (fixes the "too many requests" burst errors):
//   - Every call logs "TheStatsAPI call {label} starting at {timestamp}" so the
//     console shows exactly how fast calls fire.
//   - On HTTP 429: log the error body + Retry-After header, wait 3s, retry ONCE.
//     If it 429s again the error is thrown so the caller marks that single call
//     EMPTY/FAILED and the pipeline continues (it does not block everything).
//   - After EVERY call we wait STATSAPI_DELAY_MS (600ms) so the next sequential
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
): {
  bookmaker: string;
  is_pinnacle: boolean;
  markets: PinnacleMarketSummary[];
  raw: unknown;
} | null {
  const bookmakers = extractArray(getField(oddsJson, ["bookmakers"]) ?? oddsJson);
  if (!bookmakers.length) return null;
  // Only a bookmaker named exactly "Pinnacle" (case-insensitive) counts as the
  // sharp reference. If Pinnacle is absent we STILL extract the first available
  // book (often Bet365) so its markets can serve as a RETAIL reference for the
  // overround/C9B block — but is_pinnacle stays false so the pipeline never
  // feeds those prices into pinnacle_odds (which would wrongly trigger the 15%
  // Stake-anchoring EV reduction against a non-sharp book).
  const truePinnacle = bookmakers.find((b) => {
    const name = getField(b, ["bookmaker", "name"]);
    return typeof name === "string" && normalize(name) === "pinnacle";
  });
  const chosen = truePinnacle ?? bookmakers[0];
  const is_pinnacle = !!truePinnacle;
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

  return markets.length
    ? { bookmaker: bookmakerName, is_pinnacle, markets, raw: chosen }
    : null;
}

// API-Football Pinnacle bookmaker id (confirmed live: bookmaker=4 carries real
// Pinnacle price levels for WC2026 — 1X2, Asian Handicap, O/U, corners).
export const PINNACLE_BOOKMAKER_ID = 4;

// Build a Pinnacle price-level summary from an API-Football /odds response that
// was fetched filtered to bookmaker=4 (Pinnacle).
//
// WHY THIS EXISTS (separate from buildPinnacleSummary above, which parses the
// TheStatsAPI odds shape): C9B was repointed away from TheStatsAPI, which for
// WC2026 carries ONLY Bet365 (no Pinnacle) and has no `opening` field. This
// parser reads API-Football's { response:[ { bookmakers:[ { id, name, bets:[
// { name, values:[ { value, odd } ] } ] } ] } ] } shape — the SAME plumbing
// C9A already uses — and extracts current Pinnacle prices.
//
// PRICE LEVELS ONLY — NO HISTORY. API-Football gives a single current snapshot
// per value; there is no opening/last_seen for this competition from any source.
// Therefore `opening` is ALWAYS left null (never defaulted to the current
// value — that would fake a 0%-movement reading that does not exist) and
// movement_pct stays null → downstream must treat null as "no movement data",
// NEVER as "zero movement".
export function buildPinnacleSummaryFromApiFootball(
  oddsJson: unknown,
): {
  bookmaker: string;
  is_pinnacle: boolean;
  markets: PinnacleMarketSummary[];
  raw: unknown;
} | null {
  const responseArr = extractArray(oddsJson);
  if (!responseArr.length) return null;

  // The response is already filtered to bookmaker=4; take the first bookmaker.
  let chosen: unknown = null;
  let bookmakerName = "";
  let bookmakerId: number | null = null;
  for (const item of responseArr) {
    const bookmakers = extractArray(getField(item, ["bookmakers"]));
    if (bookmakers.length) {
      chosen = bookmakers[0];
      bookmakerId = toNum(getField(chosen, ["id"]));
      const nm = getField(chosen, ["name"]);
      bookmakerName = typeof nm === "string" ? nm : "";
      break;
    }
  }
  if (!chosen) return null;

  // Only the genuine Pinnacle book counts as sharp. C9B is Pinnacle-or-empty:
  // if the returned book is anything else, the caller records EMPTY (no retail
  // fallback here — C9A already supplies the retail reference).
  const is_pinnacle =
    bookmakerId === PINNACLE_BOOKMAKER_ID ||
    normalize(bookmakerName) === "pinnacle";

  const bets = extractArray(getField(chosen, ["bets"]));
  const markets: PinnacleMarketSummary[] = [];

  // opening is intentionally null — API-Football has no history for this feed.
  const priceOutcome = (name: string, odd: unknown) => {
    const current = toNum(odd);
    const mv = movementSignal(null, current); // → { movement_pct: null, signal: "UNKNOWN" }
    return { name, opening: null as number | null, current, ...mv };
  };
  const has = (label: string) => markets.some((m) => m.market === label);

  for (const bet of bets) {
    const betName = String(getField(bet, ["name"]) ?? "").toLowerCase();
    const values = extractArray(getField(bet, ["values"]));
    const oddOf = (v: unknown) => getField(v, ["odd", "odds", "price"]);
    const findVal = (pred: (v: string) => boolean) =>
      values.find((v) =>
        pred(String(getField(v, ["value"]) ?? "").toLowerCase()),
      );

    // 1X2
    if (/match winner|1x2|full time result|home\/away/.test(betName)) {
      const outcomes: PinnacleMarketSummary["outcomes"] = [];
      const h = findVal((s) => s.includes("home") || s === "1");
      const d = findVal((s) => s.includes("draw") || s === "x");
      const a = findVal((s) => s.includes("away") || s === "2");
      if (h) outcomes.push(priceOutcome("Home", oddOf(h)));
      if (d) outcomes.push(priceOutcome("Draw", oddOf(d)));
      if (a) outcomes.push(priceOutcome("Away", oddOf(a)));
      if (outcomes.length && !has("1X2 Full Time Result"))
        markets.push({ market: "1X2 Full Time Result", outcomes });
      continue;
    }

    // BTTS
    if (/both teams|btts/.test(betName)) {
      const outcomes: PinnacleMarketSummary["outcomes"] = [];
      const y = findVal((s) => s.includes("yes"));
      const n = findVal((s) => s.includes("no"));
      if (y) outcomes.push(priceOutcome("Yes", oddOf(y)));
      if (n) outcomes.push(priceOutcome("No", oddOf(n)));
      if (outcomes.length && !has("BTTS"))
        markets.push({ market: "BTTS", outcomes });
      continue;
    }

    // Over/Under goals
    if (
      /goals over\/under|over\/under|total goals/.test(betName) &&
      !betName.includes("corner") &&
      !/card|booking/.test(betName)
    ) {
      const outcomes: PinnacleMarketSummary["outcomes"] = [];
      for (const v of values) {
        const label = String(getField(v, ["value"]) ?? "");
        if (/^(over|under)\s/i.test(label))
          outcomes.push(priceOutcome(label, oddOf(v)));
      }
      if (outcomes.length && !has("Over/Under Goals"))
        markets.push({ market: "Over/Under Goals", outcomes });
      continue;
    }

    // Corners
    if (betName.includes("corner")) {
      const outcomes: PinnacleMarketSummary["outcomes"] = [];
      for (const v of values) {
        const label = String(getField(v, ["value"]) ?? "");
        outcomes.push(priceOutcome(label, oddOf(v)));
      }
      if (outcomes.length && !has("Corners"))
        markets.push({ market: "Corners", outcomes });
      continue;
    }

    // Asian Handicap
    if (betName.includes("asian handicap")) {
      const outcomes: PinnacleMarketSummary["outcomes"] = [];
      for (const v of values) {
        const label = String(getField(v, ["value"]) ?? "");
        outcomes.push(priceOutcome(label, oddOf(v)));
      }
      if (outcomes.length && !has("Asian Handicap"))
        markets.push({ market: "Asian Handicap", outcomes });
      continue;
    }
  }

  return markets.length
    ? { bookmaker: bookmakerName || "Pinnacle", is_pinnacle, markets, raw: chosen }
    : null;
}

// ============================================================================
// CLV CLOSING-ODDS CAPTURE (PART 1B)
// ----------------------------------------------------------------------------
// Standalone fetcher that runs ONLY the odds calls (CALL 9 Stake path + CALL 9B
// TheStatsAPI path) FRESH, bypassing the 15-min per-call cache used by
// collectMatchData (we call afGet / saGet directly). Used to snapshot the
// closing line near kickoff for Closing Line Value (CLV) tracking.
//
// Source precedence:
//   - 9B is_pinnacle=true  → store Pinnacle last_seen prices, source PINNACLE.
//                            Pinnacle prices OVERRIDE Stake per market.
//   - Stake succeeded      → source STAKE (Stake prices).
//   - Stake failed, 9B retail only → source RETAIL (retail last_seen prices).
//   - nothing usable       → return null (NEVER guess a price).
// ============================================================================
export async function captureClosingOdds(
  match: AnalysedMatch,
): Promise<ClosingCapture | null> {
  const prices: Record<string, Array<{ selection: string; odds: number }>> = {};

  // ---- Stake odds (CALL 9 path), fresh ------------------------------------
  let stakeOk = false;
  try {
    let stakeId: string | null =
      typeof window !== "undefined"
        ? window.localStorage.getItem("stake_bookmaker_id")
        : null;
    if (!stakeId) {
      const bookmakers = await afGet(`/odds/bookmakers`);
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
    );
    const trimmed = extractStakeMarkets(afOdds);
    if (trimmed) {
      for (const [label, values] of Object.entries(trimmed.markets)) {
        const outs = values
          .map((v) => ({ selection: v.value, odds: Number(v.odd) }))
          .filter((o) => Number.isFinite(o.odds) && o.odds > 0);
        if (outs.length) prices[label] = outs;
      }
      stakeOk = Object.keys(prices).length > 0;
    }
  } catch (e) {
    console.warn("[clv] Stake odds capture failed", e);
  }

  // ---- TheStatsAPI odds (CALL 9B path), fresh -----------------------------
  let isPinnacle = false;
  let retailOnly = false;
  try {
    const ref = await resolveStatsApiMatch(match.home, match.away, match.kickoffUtc);
    const matchId = ref?.id ?? null;
    if (matchId) {
      const oddsJson = await saGet(`/football/matches/${matchId}/odds`);
      const summary = buildPinnacleSummary(oddsJson);
      if (summary) {
        isPinnacle = summary.is_pinnacle;
        // Build { label → outcomes } from the summary's last_seen prices.
        const saPrices: Record<string, Array<{ selection: string; odds: number }>> = {};
        for (const mk of summary.markets) {
          const outs = mk.outcomes
            .map((o) => ({ selection: o.name, odds: Number(o.current) }))
            .filter((o) => Number.isFinite(o.odds) && o.odds > 0);
          if (outs.length) saPrices[mk.market] = outs;
        }
        if (isPinnacle) {
          // Pinnacle takes precedence per market — overlay onto Stake prices.
          for (const [label, outs] of Object.entries(saPrices)) prices[label] = outs;
        } else if (!stakeOk) {
          // Retail 9B stored only when Stake failed.
          for (const [label, outs] of Object.entries(saPrices)) prices[label] = outs;
          retailOnly = Object.keys(saPrices).length > 0;
        }
      }
    }
  } catch (e) {
    console.warn("[clv] TheStatsAPI odds capture failed", e);
  }

  if (Object.keys(prices).length === 0) return null;

  const source: ClosingCapture["source"] = isPinnacle
    ? "PINNACLE"
    : stakeOk
      ? "STAKE"
      : retailOnly
        ? "RETAIL"
        : "STAKE";

  const now = Date.now();
  const koMs = Date.parse(match.kickoffUtc);
  const minutesBeforeKickoff = Number.isFinite(koMs)
    ? Math.round((koMs - now) / 60000)
    : 0;

  const capture: ClosingCapture = {
    matchId: match.id,
    capturedAt: now,
    minutesBeforeKickoff,
    source,
    prices,
  };
  writeClosingCapture(capture);
  return capture;
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

// Trim the RAW API-Football /odds response down to ONLY the markets the analysis
// actually uses. The raw response for a single bookmaker still carries ~160 bet
// markets (correct score, exact goals, halftime combos, etc.) with dozens of
// values each — dumping all of that into the Claude prompt inflated a single run
// past 200k input tokens, which made Claude take >100s and the request die with
// a Cloudflare 524 origin-timeout. We keep 1X2, Over/Under 2.5, BTTS, Corners
// 9.5 and Asian Handicap only.
const WANTED_STAKE_MARKETS: Array<{
  label: string;
  match: (name: string) => boolean;
  valueFilter?: (value: string) => boolean;
}> = [
  {
    label: "1X2 (Match Winner)",
    match: (n) => /match winner|1x2|full time result|home\/away/.test(n),
  },
  {
    label: "Over/Under 2.5 Goals",
    match: (n) =>
      /goals over\/under|over\/under|total goals/.test(n) &&
      !n.includes("corner") &&
      !/card|booking/.test(n),
    valueFilter: (v) => v.includes("2.5"),
  },
  {
    label: "Both Teams To Score",
    match: (n) => /both teams|btts/.test(n),
  },
  {
    // Corners: extract the 8.5 / 9.5 / 10.5 lines when present (9.5 is the
    // primary line the report displays; 8.5/10.5 come free from the same bet).
    label: "Corners Over/Under",
    match: (n) => n.includes("corner"),
    valueFilter: (v) => v.includes("8.5") || v.includes("9.5") || v.includes("10.5"),
  },
  {
    // Total cards / bookings. API-Football / Stake expose this under several
    // names ("Cards Over/Under", "Total Cards", "Bookings Over/Under",
    // "Total Bookings"), so we match broadly on card|booking.
    //
    // INTENTIONALLY KEPT — DO NOT "FIX". Verified live on 2026-07-02 across 3
    // WC2026 fixtures: API-Football's /odds feed carries ZERO cards markets
    // across all 33 bookmakers, even though the bet-type ID exists in the
    // catalog. This matcher is correct and harmless (it simply never matches
    // today); it stays in place so cards extraction works automatically the
    // day a bookmaker/feed populates the market. See src/lib/dataGaps.ts
    // (CARDS_MARKET_SOURCE_AVAILABLE) for the display-side gate.
    // Lines 2.5 / 3.5 / 4.5 kept (3.5 is the primary line the report shows).
    label: "Cards Over/Under",
    match: (n) => /card|booking/.test(n),
    valueFilter: (v) => v.includes("2.5") || v.includes("3.5") || v.includes("4.5"),
  },
  {
    label: "Asian Handicap",
    match: (n) => n.includes("asian handicap"),
  },
];

export function extractStakeMarkets(
  stakeOdds: unknown,
): {
  bookmaker: string | null;
  markets: Record<string, Array<{ value: string; odd: string }>>;
} | null {
  const responseArr = extractArray(stakeOdds);
  if (!responseArr.length) return null;
  let bookmakerName: string | null = null;
  const markets: Record<string, Array<{ value: string; odd: string }>> = {};
  for (const item of responseArr) {
    const bookmakers = extractArray(getField(item, ["bookmakers"]));
    for (const bk of bookmakers) {
      if (bookmakerName === null) {
        const bn = getField(bk, ["name"]);
        if (typeof bn === "string") bookmakerName = bn;
      }
      const bets = extractArray(getField(bk, ["bets"]));
      for (const bet of bets) {
        const betName = String(getField(bet, ["name"]) ?? "").toLowerCase();
        const spec = WANTED_STAKE_MARKETS.find((w) => w.match(betName));
        if (!spec) continue;
        const values = extractArray(getField(bet, ["values"]))
          .map((v) => ({
            value: String(getField(v, ["value"]) ?? ""),
            odd: String(getField(v, ["odd", "odds", "price"]) ?? ""),
          }))
          .filter((v) =>
            spec.valueFilter ? spec.valueFilter(v.value.toLowerCase()) : true,
          );
        if (values.length && !markets[spec.label]) markets[spec.label] = values;
      }
    }
  }
  return Object.keys(markets).length ? { bookmaker: bookmakerName, markets } : null;
}


// Step 4 — PINNACLE GAP CHECK: compare C9A retail price vs C9B Pinnacle current
// price (1X2). Higher decimal odds = better price for the bettor. This needs
// only a SINGLE price level on each side (not history), so it is unaffected by
// the missing line-movement data. gap_pct = (stake/pinnacle - 1) * 100 (matches
// adjustEVForPinnacleGap): positive = retail price beats Pinnacle.
export function buildStakeGapCheck(
  stakeOdds: unknown,
  markets: PinnacleMarketSummary[],
): Array<{
  outcome: string;
  stake: number | null;
  pinnacle: number | null;
  gap_pct: number | null;
  verdict: string;
}> {
  const stake1X2 = extractStake1X2(stakeOdds);
  const pinnacle1X2 = markets.find((m) => m.market === "1X2 Full Time Result");
  if (!pinnacle1X2) return [];
  return pinnacle1X2.outcomes
    .filter((o) => ["Home", "Draw", "Away"].includes(o.name))
    .map((o) => {
      const stakePrice = stake1X2[o.name] ?? null;
      const pinPrice = o.current;
      let verdict = "UNKNOWN";
      let gap_pct: number | null = null;
      if (stakePrice != null && pinPrice != null && pinPrice !== 0) {
        gap_pct = Math.round((stakePrice / pinPrice - 1) * 1000) / 10;
        if (stakePrice > pinPrice) verdict = "STAKE OFFERS VALUE";
        else if (pinPrice > stakePrice) verdict = "STAKE WORSE";
        else verdict = "EQUAL";
      }
      return { outcome: o.name, stake: stakePrice, pinnacle: pinPrice, gap_pct, verdict };
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

// Count the players listed in one side's starting_xi (handles the nested
// `data.home/away` envelope and bare `home/away` shapes).
function sideXICount(side: unknown): number {
  const xi = getField(side, ["starting_xi", "startingXi", "startingXI", "lineup"]);
  return extractArray(xi).length;
}

// A TheStatsAPI lineups response is only a REAL confirmed lineup when BOTH
// teams' starting_xi arrays are actually populated. TheStatsAPI has been
// observed (e.g. Côte d'Ivoire vs Norway, mt_740177219) returning
// `confirmed: true` with empty starting_xi/substitutes arrays — a malformed
// state the spec says should not exist. This helper is the single source of
// truth for "are the lineups genuinely populated?", used by both the main
// pipeline (CALL 6 / S3) and the refetch path so the behaviour can't drift.
export function lineupsArePopulated(payload: unknown): boolean {
  const node = getField(payload, ["data"]) ?? payload;
  const homeXI = sideXICount(getField(node, ["home"]));
  const awayXI = sideXICount(getField(node, ["away"]));
  if (homeXI > 0 && awayXI > 0) return true;
  // Array-shaped responses (one entry per team): require at least two
  // populated sides.
  const sides = extractArray(node).filter((s) => sideXICount(s) > 0);
  return sides.length >= 2;
}

// Detect the specific malformed pattern: the API claims confirmed=true but at
// least one starting_xi is empty. Used purely for diagnostic logging so we can
// tell whether this recurs for certain matches/competitions.
export function lineupConfirmedButEmpty(payload: unknown): boolean {
  const node = getField(payload, ["data"]) ?? payload;
  const confirmed = getField(node, ["confirmed"]) === true;
  return confirmed && !lineupsArePopulated(payload);
}

// Count the players listed in one side's substitutes/bench array.
function sideSubsCount(side: unknown): number {
  const subs = getField(side, ["substitutes", "subs", "bench"]);
  return extractArray(subs).length;
}

// Total squad size (substitutes) across both sides. When starting_xi is empty
// but TheStatsAPI has dumped the full ~26-man squad into `substitutes`, that is
// the tell-tale "announced but propagating" signature observed live for
// France vs Sweden (mt_401944555): confirmed=true ~T-90, full squad in subs,
// starting_xi only split out at ~T-0 (kickoff).
function totalSquadCount(payload: unknown): number {
  const node = getField(payload, ["data"]) ?? payload;
  let total = sideSubsCount(getField(node, ["home"])) + sideSubsCount(getField(node, ["away"]));
  for (const s of extractArray(node)) total += sideSubsCount(s);
  return total;
}

// The three meaningfully-different lineup states (see STEP 3 of the lineup
// investigation). These drive both the debug log wording AND the confidence
// penalty — they are NOT interchangeable:
//   NOT_ANNOUNCED  — 404 / empty payload: data doesn't exist yet at all.
//   PROPAGATING    — confirmed=true (or a full squad sitting in substitutes)
//                    but starting_xi still empty: the lineup IS known to exist,
//                    TheStatsAPI just hasn't split the XI out of the squad yet.
//   POPULATED      — starting_xi has real players on both sides.
export type LineupState = "NOT_ANNOUNCED" | "PROPAGATING" | "POPULATED";

export function classifyLineupState(payload: unknown): LineupState {
  if (lineupsArePopulated(payload)) return "POPULATED";
  const node = getField(payload, ["data"]) ?? payload;
  const confirmed = getField(node, ["confirmed"]) === true;
  // "Announced but propagating" = the lineup is known to exist. Two signatures:
  //   1. confirmed=true with empty starting_xi, or
  //   2. a substantial squad already populated in `substitutes` (>= 11 total).
  if (confirmed || totalSquadCount(payload) >= 11) return "PROPAGATING";
  return "NOT_ANNOUNCED";
}

// Human-readable label + the actionable note for each lineup state.
export const LINEUP_STATE_INFO: Record<
  LineupState,
  { label: string; note: string }
> = {
  NOT_ANNOUNCED: {
    label: "LINEUP NOT ANNOUNCED",
    note: "Endpoint returned 404 — the team sheet has genuinely not been published yet. Expected before T-60min. Analysis proceeds on historical/expected XI.",
  },
  PROPAGATING: {
    label: "LINEUP PROPAGATING",
    note: "confirmed=true but starting_xi arrays are still empty — the lineup is known to exist and the data is being ingested. Retried up to 5×60s, then fell back to API-Football.",
  },
  POPULATED: {
    label: "LINEUP CONFIRMED",
    note: "confirmed=true with a populated starting_xi for both teams. Source: TheStatsAPI (or API-Football fallback).",
  },
};

// API-Football lineup fallback. When TheStatsAPI is still PROPAGATING (or
// NOT_ANNOUNCED) after the retry burst, pull the XI from API-Football's
// /fixtures/lineups and normalise it into the same {home,away,starting_xi}
// shape the rest of the pipeline reads, tagged source:"API-Football". Returns
// null when API-Football has no usable (populated) XI either.
async function fetchApiFootballLineupFallback(match: {
  id: number;
  homeId: number;
  awayId: number;
  home: string;
  away: string;
}): Promise<unknown | null> {
  let raw: unknown;
  try {
    raw = await afGet(`/fixtures/lineups?fixture=${match.id}`);
  } catch (e) {
    console.warn(
      `[S3 lineups/AF-fallback] request failed for fixture=${match.id} (${match.home} vs ${match.away})`,
      e,
    );
    return null;
  }
  const entries = extractArray(raw);
  console.log(
    `[S3 lineups/AF-fallback] API-Football /fixtures/lineups?fixture=${match.id} ` +
      `(${match.home} vs ${match.away}) returned ${entries.length} team block(s).`,
  );
  if (entries.length < 2) return null;

  const mapPlayer = (p: unknown) => {
    const pl = getField(p, ["player"]) ?? p;
    return {
      id: String(getField(pl, ["id"]) ?? ""),
      name: getField(pl, ["name"]) ?? null,
      position: getField(pl, ["pos", "position"]) ?? null,
      jersey_number: getField(pl, ["number", "jersey_number"]) ?? null,
    };
  };
  const mapSide = (entry: unknown) => {
    const team = getField(entry, ["team"]);
    return {
      id: String(getField(team, ["id"]) ?? ""),
      name: getField(team, ["name"]) ?? null,
      formation: getField(entry, ["formation"]) ?? null,
      starting_xi: extractArray(getField(entry, ["startXI", "starting_xi"])).map(mapPlayer),
      substitutes: extractArray(getField(entry, ["substitutes"])).map(mapPlayer),
    };
  };
  const sides = entries.map(mapSide);
  const home = sides.find((s) => s.id === String(match.homeId)) ?? sides[0];
  const away = sides.find((s) => s.id === String(match.awayId)) ?? sides[1];

  const payload = { confirmed: true, source: "API-Football", home, away };
  if (!lineupsArePopulated(payload)) return null;
  return payload;
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

// FIX 6 — reconstruct PRE-MATCH standings as of a given kickoff.
//
// The old dead-rubber path judged pre-match stakes with FINAL standings. Once
// the group stage is complete every rival has 0 games left, so clinchedTop2 is
// true for EVERY opponent that FINISHED top-2 — falsely discounting every
// matchday-3 fixture against a top-2 finisher, and understating best-case
// points in the third-place race. Replaying only the group games that kicked
// off STRICTLY before the cutoff rebuilds the table the opponent actually
// faced.
//
// `groupRows` (from the final all-groups standings) is used ONLY as a
// name → {team_id, group_label} directory. `cutoffKickoffIso` is the full ISO
// datetime of the fixture being judged; the strict `<` comparison excludes the
// fixture itself and any simultaneous kickoffs.
export function buildPreMatchStandings(
  completedFixtures: unknown[],
  groupRows: StandingRow[],
  cutoffKickoffIso: string,
): AllStandings {
  // Directory: normalized team name -> {team_id, group_label}.
  const dir = new Map<string, { team_id: string; group_label: string }>();
  interface Acc {
    team_id: string;
    team_name: string;
    group_label: string;
    points: number;
    goal_difference: number;
    goals_for: number;
    matches_played: number;
  }
  const acc = new Map<string, Acc>();
  for (const r of groupRows) {
    if (r.group_label === null) continue;
    const key = normalize(r.team_name);
    if (key) dir.set(key, { team_id: r.team_id, group_label: r.group_label });
    if (!acc.has(r.team_id)) {
      // Seed a zero row for every known group team — teams with no prior game
      // still appear (0 pts, 0 played) so positions are complete.
      acc.set(r.team_id, {
        team_id: r.team_id,
        team_name: r.team_name,
        group_label: r.group_label,
        points: 0,
        goal_difference: 0,
        goals_for: 0,
        matches_played: 0,
      });
    }
  }

  const resolveId = (
    name: string,
  ): { team_id: string; group_label: string } | null => {
    const n = normalize(name);
    if (!n) return null;
    const exact = dir.get(n);
    if (exact) return exact;
    for (const [k, v] of dir) {
      if (k.includes(n) || n.includes(k)) return v;
    }
    return null;
  };

  for (const item of completedFixtures) {
    const fixture = getField(item, ["fixture"]);
    const date = String(getField(fixture, ["date"]) ?? "");
    // Strict ISO compare: excludes the analysed fixture and simultaneous games.
    if (!date || !(date < cutoffKickoffIso)) continue;
    const round = String(getField(getField(item, ["league"]), ["round"]) ?? "");
    if (!/group/i.test(round)) continue;
    const teams = getField(item, ["teams"]);
    const goals = getField(item, ["goals"]);
    const hg = Number(getField(goals, ["home"]));
    const ag = Number(getField(goals, ["away"]));
    if (!Number.isFinite(hg) || !Number.isFinite(ag)) continue;
    const homeRes = resolveId(String(getField(getField(teams, ["home"]), ["name"]) ?? ""));
    const awayRes = resolveId(String(getField(getField(teams, ["away"]), ["name"]) ?? ""));
    if (!homeRes || !awayRes) continue;
    const hRow = acc.get(homeRes.team_id);
    const aRow = acc.get(awayRes.team_id);
    if (!hRow || !aRow) continue;
    hRow.matches_played++;
    aRow.matches_played++;
    hRow.goals_for += hg;
    aRow.goals_for += ag;
    hRow.goal_difference += hg - ag;
    aRow.goal_difference += ag - hg;
    if (hg > ag) hRow.points += 3;
    else if (hg < ag) aRow.points += 3;
    else {
      hRow.points += 1;
      aRow.points += 1;
    }
  }

  // Rank per group (points -> GD -> GF) to derive position.
  const byGroup = new Map<string, Acc[]>();
  for (const r of acc.values()) {
    if (!byGroup.has(r.group_label)) byGroup.set(r.group_label, []);
    byGroup.get(r.group_label)!.push(r);
  }
  const groupRowsOut: StandingRow[] = [];
  for (const [g, list] of byGroup) {
    list.sort(
      (a, b) =>
        b.points - a.points ||
        b.goal_difference - a.goal_difference ||
        b.goals_for - a.goals_for,
    );
    list.forEach((r, i) => {
      groupRowsOut.push({
        team_id: r.team_id,
        team_name: r.team_name,
        points: r.points,
        position: i + 1,
        matches_played: r.matches_played,
        goal_difference: r.goal_difference,
        goals_for: r.goals_for,
        group_label: g,
      });
    });
  }

  const thirdPlaceTable: ThirdPlaceRow[] = groupRowsOut
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

  return { groupRows: groupRowsOut, thirdPlaceTable, raw: groupRowsOut };
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

  // FIX 6 — reconstruct PRE-MATCH standings per fixture instead of judging with
  // final standings. getCompletedFixtures(2026) is day-cached, so this is
  // usually zero new API calls. On failure we DO NOT discount (a missed
  // discount is cheap; a false 0.2x corrupts form).
  let completed: unknown[];
  try {
    completed = await getCompletedFixtures(2026);
  } catch (e) {
    return {
      adjustment: applyDeadRubberDiscount(last5),
      fixtureChecks: [],
      groupFixtureCount: groupFixtures.length,
      triggered: false,
      reason: `pre-match standings unavailable — no discount applied (${
        e instanceof Error ? e.message : String(e)
      })`,
    };
  }

  const fixtureChecks: TeamDeadRubberResult["fixtureChecks"] = [];
  for (const f of last5) {
    if (!f.is_group_stage) continue;
    try {
      // Rebuild the table as it stood immediately BEFORE this fixture kicked off.
      const preMatch = buildPreMatchStandings(completed, all.groupRows, f.date);
      const oppRow = resolveOpponentStandingRow(f.opponentName, preMatch.groupRows);
      if (!oppRow || oppRow.group_label === null) continue;
      const opponentGroupStandings = preMatch.groupRows.filter(
        (r) => r.group_label === oppRow.group_label,
      );
      const r = detectDeadRubber({
        fixture_matchday: f.matchday,
        fixture_date: f.date,
        opponent_team_id: oppRow.team_id,
        opponent_group_standings: opponentGroupStandings,
        all_groups_third_place_table: preMatch.thirdPlaceTable,
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
    } catch {
      // Per-fixture reconstruction failure → no discount for this fixture.
      f.is_dead_rubber = false;
    }
  }

  return {
    adjustment: applyDeadRubberDiscount(last5),
    fixtureChecks,
    groupFixtureCount: groupFixtures.length,
    triggered: true,
    reason: `Pre-match standings reconstructed per fixture — ${groupFixtures.length} group-stage fixture(s) checked against the table as it stood before each kickoff.`,
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
  // Reset per-run lineup state; CALL 6 updates it as it retries.
  lastLineupState = "NOT_ANNOUNCED";


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
  // fetchedAt of any result loaded from cache, so record() can preserve the
  // original fetch time instead of stamping "now".
  const cachedAtMap: Record<string, number> = {};

  const record = (
    key: string,
    label: string,
    status: CallStatus,
    data?: unknown,
    error?: string,
    fromCache = false,
  ) => {
    const validated = data !== undefined ? replaceNulls(data) : undefined;
    const fetchedAt = fromCache ? (cachedAtMap[key] ?? Date.now()) : Date.now();
    callResults[key] = { key, label, status, data: validated, error, cached: fromCache, fetchedAt };
    // Persist fresh (non-cache) results so a later run / individual retry can
    // reuse them. FAILED and SKIPPED are never cached (so they always re-run);
    // lineups ("6") are excluded inside writeCallCache.
    if (!fromCache && status !== "FAILED" && status !== "SKIPPED" && status !== "BLOCKED") {
      writeCallCache(match.id, key, { key, label, status, data: validated, error, fetchedAt });
    }
    console.log(
      `[analyse] ${key} (${label}): ${status}${fromCache ? " [CACHED]" : ""}`,
      error ?? "",
    );
  };

  // Load a valid (non-expired) cached result for `key` and record it as CACHED.
  // Returns true when a cache hit was used (so the caller skips the real call).
  const tryLoadCache = (key: string): boolean => {
    const c = readCallCache(match.id, key);
    if (!c) return false;
    cachedAtMap[key] = c.fetchedAt;
    record(key, c.label, c.status as CallStatus, c.data, c.error, true);
    return true;
  };



  // Wrapper that runs one numbered step and records its result.
  const runStep = async (
    key: string,
    label: string,
    fn: () => Promise<unknown>,
    opts: {
      skip?: boolean;
      skipReason?: string;
      block?: boolean;
      blockReason?: string;
    } = {},
  ) => {
    stepKeys.push(key);
    const step = stepKeys.length;
    onProgress({ step, total: TOTAL_STEPS, label });
    // A blocked call (C1 fixture mismatch) must NEVER fire its HTTP request.
    if (opts.block) {
      record(key, label, "BLOCKED", undefined, opts.blockReason);
      return;
    }
    if (opts.skip) {
      record(key, label, "SKIPPED", undefined, opts.skipReason);
      return;
    }
    // Persistent per-call cache: reuse a fresh cached result instead of calling.
    if (tryLoadCache(key)) return;
    currentDebugCall = key;
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

  // C1 FIXTURE VERIFICATION (runs FIRST). Confirms the resolved API-Football
  // fixture id actually belongs to the teams we intend to analyse. Every
  // API-Football id-dependent call (C3/C4/C5/C7/C8/C9A/C10) is BLOCKED if this
  // fails, so we never silently analyse the wrong match.
  let fixtureVerified = true;
  let fixtureMismatchReason: string | null = null;
  {
    stepKeys.push("C1");
    onProgress({
      step: stepKeys.length,
      total: TOTAL_STEPS,
      label: "Verifying fixture id (C1)...",
    });
    if (tryLoadCache("C1")) {
      // A cached FAILED is never persisted, so a cache hit means SUCCESS or an
      // inconclusive EMPTY — neither should block.
      fixtureVerified = callResults["C1"]?.status !== "FAILED";
    } else {
      currentDebugCall = "C1";
      try {
        const v = await verifyFixtureById(match);
        const inconclusive = v.reason.startsWith("INCONCLUSIVE");
        if (v.verified) {
          fixtureVerified = true;
          record("C1", "Fixture verification", "SUCCESS", v);
        } else if (inconclusive) {
          // Fail-safe: an unreadable verification response must NOT block the
          // whole run. Proceed with a caveat.
          fixtureVerified = true;
          record("C1", "Fixture verification", "EMPTY", v, v.reason);
        } else {
          fixtureVerified = false;
          fixtureMismatchReason = v.reason;
          record("C1", "Fixture verification", "FAILED", v, v.reason);
          console.error(`[analyse] C1 FIXTURE MISMATCH — ${v.reason}`);
        }
      } catch (e) {
        // Verification call itself errored (network / rate limit). Inconclusive
        // → do not block; the dependent calls proceed with a caveat row.
        fixtureVerified = true;
        record(
          "C1",
          "Fixture verification",
          "EMPTY",
          undefined,
          `Verification inconclusive — ${e instanceof Error ? e.message : String(e)}`,
        );
      } finally {
        currentDebugCall = null;
      }
    }
  }

  // Block opts for any API-Football call that depends on the C1 fixture id.
  const blockOpts = fixtureVerified
    ? {}
    : {
        block: true,
        blockReason: `C1 fixture mismatch, cannot proceed. ${fixtureMismatchReason ?? ""}`.trim(),
      };


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
  await runStep(
    "3",
    "Fetching head-to-head data... (3/11)",
    () => afGet(`/fixtures/headtohead?h2h=${match.homeId}-${match.awayId}&last=10`, afKey),
    blockOpts,
  );

  // FIX 3b — PAST MEETINGS fallback. When CALL 3 (API-Football headtohead) is
  // EMPTY, reconstruct head-to-head from TheStatsAPI /football/matches (there is
  // no dedicated H2H endpoint). The existing H2H gate (3+ competitive) still
  // applies downstream; scorelines are formatted via scorelinesFrom on the
  // API-Football-shaped rows we synthesise here.
  if (callResults["3"]?.status === "EMPTY") {
    const ref = await ensureStatsApiMatch();
    if (ref?.homeTeamId) {
      currentDebugCall = "3";
      try {
        const today = new Date().toISOString().slice(0, 10);
        const payload = await saGet(
          `/football/matches?team_id=${ref.homeTeamId}&date_to=${today}&per_page=100`,
        );
        const fixtures = statsApiMatchesToFixtures(
          payload,
          ref.awayTeamName ?? match.away,
        );
        record(
          "3",
          "PAST MEETINGS (TheStatsAPI workaround — not a dedicated H2H endpoint)",
          fixtures.length ? "SUCCESS" : "EMPTY",
          fixtures.length ? fixtures : undefined,
          fixtures.length
            ? undefined
            : "No past meetings found via TheStatsAPI fallback.",
        );
      } catch (e) {
        // Keep the original EMPTY status on failure.
        console.warn("[analyse] CALL 3 TheStatsAPI fallback failed", e);
      } finally {
        currentDebugCall = null;
      }
    }
  }

  let homeFixtureIds: number[] = [];
  await runStep(
    "4-1",
    "Fetching recent form step 1... (4/11)",
    async () => afGet(`/fixtures?team=${match.homeId}&last=5&league=1&season=2026`, afKey),
    blockOpts,
  );
  // Derive ids AFTER the step so a cached 4-1 (fn not executed) still feeds 4-3.
  homeFixtureIds = extractArray(callResults["4-1"]?.data)
    .map((f) => getField(getField(f, ["fixture"]), ["id"]))
    .filter((id): id is number => typeof id === "number");

  // 4 step 2: away recent form
  let awayFixtureIds: number[] = [];
  await runStep(
    "4-2",
    "Fetching recent form step 2... (5/11)",
    async () => afGet(`/fixtures?team=${match.awayId}&last=5&league=1&season=2026`, afKey),
    blockOpts,
  );
  awayFixtureIds = extractArray(callResults["4-2"]?.data)
    .map((f) => getField(getField(f, ["fixture"]), ["id"]))
    .filter((id): id is number => typeof id === "number");

  // 4 step 3: combined batch
  await runStep(
    "4-3",
    "Fetching recent form batch... (6/11)",
    () => {
      const ids = Array.from(new Set([...homeFixtureIds, ...awayFixtureIds])).slice(0, 10);
      if (ids.length === 0) return Promise.resolve(null);
      return afGet(`/fixtures?ids=${ids.join("-")}`, afKey);
    },
    blockOpts,
  );

  // 5: injuries
  await runStep(
    "5",
    "Fetching injuries... (7/11)",
    () => afGet(`/injuries?fixture=${match.id}`, afKey),
    blockOpts,
  );

  // FIX 3a — INJURIES fallback. When CALL 5 (API-Football /injuries) is EMPTY or
  // FAILED, pull TheStatsAPI /football/teams/{id}/injuries-suspensions for each
  // side and merge into the CALL 5 shape the compactor reads. Only active=true
  // records are kept, so they count as absences for the CALL 6B trigger.
  {
    const c5 = callResults["5"]?.status;
    if (c5 === "EMPTY" || c5 === "FAILED") {
      const ref = await ensureStatsApiMatch();
      if (ref?.homeTeamId || ref?.awayTeamId) {
        currentDebugCall = "5";
        const merged: Array<Record<string, unknown>> = [];
        let anyFetched = false;
        const teams: Array<[string | null, string | null]> = [
          [ref?.homeTeamId ?? null, ref?.homeTeamName ?? match.home],
          [ref?.awayTeamId ?? null, ref?.awayTeamName ?? match.away],
        ];
        for (const [teamId, teamName] of teams) {
          if (!teamId) continue;
          try {
            const payload = await saGet(
              `/football/teams/${teamId}/injuries-suspensions`,
            );
            anyFetched = true;
            merged.push(...mapStatsApiInjuries(payload, teamName));
          } catch (e) {
            console.warn(
              `[analyse] CALL 5 injuries fallback failed for ${teamId}`,
              e,
            );
          }
        }
        if (anyFetched) {
          record(
            "5",
            "Injuries (TheStatsAPI injuries-suspensions fallback)",
            merged.length ? "SUCCESS" : "EMPTY",
            merged.length ? merged : undefined,
            merged.length
              ? undefined
              : "No active injuries/suspensions via TheStatsAPI fallback.",
          );
        }
        currentDebugCall = null;
      }
    }
  }

  // 9: odds (Stake via API-Football only)
  // FIX 5 — runs immediately after CALL 5 (injuries) and BEFORE the CALL 6
  // lineup retry loop, so odds are captured fresh rather than going stale while
  // CALL 6 blocks up to 5×60s inside the pre-kickoff window. Order preserved:
  // 9 → 9B → 6.
  await runStep("9", "Fetching odds... (8/11)", async () => {
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
  }, blockOpts);

  // CALL 9B: Pinnacle PRICE LEVELS via API-Football (bookmaker=4).
  //
  // Repointed from TheStatsAPI. Verified live: TheStatsAPI carries ONLY Bet365
  // for WC2026 (no Pinnacle, no `opening` field), whereas API-Football's own
  // /odds feed filtered to bookmaker=4 genuinely carries Pinnacle for this
  // competition. This reuses the SAME API-Football odds plumbing C9A calls,
  // just with a different bookmaker filter — not a new integration.
  //
  // PRICE LEVELS ONLY: API-Football returns a single current snapshot per value
  // (no opening/last_seen history), so opening/movement stay null. C9B is now
  // Pinnacle-or-empty — there is NO retail fallback (C9A already supplies the
  // retail reference price). The old TheStatsAPI Bet365 "Pinnacle" fallback is
  // removed entirely.
  {
    stepKeys.push("9B");
    onProgress({
      step: stepKeys.length,
      total: TOTAL_STEPS,
      label: "Fetching Pinnacle odds (API-Football bookmaker=4)...",
    });
    if (!tryLoadCache("9B")) {
    currentDebugCall = "9B";
    try {
      // C9A/C9B collision guard: C9A resolves whichever bookmaker the API-Football
      // feed returns first (historically labeled "Stake"). If that ever resolves
      // to Pinnacle (id 4), C9B would duplicate C9A's book — record EMPTY so the
      // two references never silently collapse into the same book.
      const c9aBookmakerId =
        typeof window !== "undefined"
          ? window.localStorage.getItem("stake_bookmaker_id")
          : null;
      if (c9aBookmakerId && String(c9aBookmakerId) === String(PINNACLE_BOOKMAKER_ID)) {
        record(
          "9B",
          "Pinnacle odds (API-Football bookmaker=4)",
          "EMPTY",
          undefined,
          "C9A already resolved to Pinnacle (bookmaker=4); C9B would duplicate the same book. Pinnacle handled by C9A this run.",
        );
      } else {
        const oddsJson = await afGet(
          `/odds?fixture=${match.id}&bookmaker=${PINNACLE_BOOKMAKER_ID}`,
          afKey,
        );
        const summary = buildPinnacleSummaryFromApiFootball(oddsJson);

        if (!summary || !summary.is_pinnacle) {
          record(
            "9B",
            "Pinnacle odds (API-Football bookmaker=4)",
            "EMPTY",
            { source: "API-Football bookmaker=4" },
            "Pinnacle unavailable — API-Football returned no bookmaker=4 markets for this fixture. is_pinnacle=false, overround_pinnacle=null, pinnacle_available=false.",
          );
        } else {
          // PINNACLE GAP CHECK vs C9A retail 1X2 (single snapshot each side —
          // valid without history).
          const stakeRoot = callResults["9"]?.data as { stakeOdds?: unknown } | undefined;
          const gapCheck = buildStakeGapCheck(stakeRoot?.stakeOdds, summary.markets);

          record("9B", "Pinnacle odds (API-Football bookmaker=4)", "SUCCESS", {
            matchId: match.id,
            bookmaker: summary.bookmaker,
            is_pinnacle: summary.is_pinnacle,
            source: "API-Football bookmaker=4",
            markets: summary.markets,
            gap_check: gapCheck,
            note:
              "Pinnacle PRICE LEVELS from API-Football bookmaker=4 (genuine sharp reference). " +
              "You MAY populate pinnacle_odds from these current prices. " +
              "NO line-movement history exists for this competition from any source: opening is null on every outcome and movement_pct is null → treat as 'NO movement data', NEVER as 'zero movement'. Do NOT infer SHARP MOVE / DRIFT / STABLE from this. " +
              "pinnacle_gap_check compares the C9A retail price vs this Pinnacle price per 1X2 outcome (single snapshot each — valid without history); gap_pct = (retail/pinnacle - 1) * 100.",
          });
        }
      }
    } catch (e) {
      record(
        "9B",
        "Pinnacle odds (API-Football bookmaker=4)",
        "EMPTY",
        undefined,
        `Pinnacle data unavailable — ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      currentDebugCall = null;
    }
    }
  }



  // 6 (S3): confirmed lineups (TheStatsAPI).
  // Reuses the S0 match_id, then fetches /football/matches/{match_id}/lineups.
  //
  // LIVE-OBSERVED PROPAGATION BEHAVIOUR (France vs Sweden, mt_401944555):
  // TheStatsAPI sets confirmed=true ~T-90 and dumps the FULL ~26-man squad into
  // `substitutes`, but does NOT split the starting XI out of the squad until
  // ~T-0 (kickoff). The delay between confirmed=true and a populated
  // starting_xi is therefore tens of minutes and unpredictable — far longer
  // than any 3-5 minute retry window can bridge. This is Option B: do a short
  // burst of in-line retries (5 x 60s), and if still PROPAGATING, hand off to a
  // final near-kickoff (T-15) background re-check in the UI.
  await runStep("6", "Fetching confirmed lineups (TheStatsAPI)... (9/11)", async () => {
    const matchId = await ensureStatsApiMatchId();
    if (!matchId) {
      throw new Error(
        "STATSAPI_ID_NOT_FOUND — no TheStatsAPI match resolved for these teams/date. Lineups unavailable.",
      );
    }
    const withinWindow = match.minutesUntilKickoff <= 90;
    // Option A bump folded in: 5 x 60s (5 minutes) inside the pre-kickoff window
    // instead of 3 x 60s. Wider window, still cheap.
    const maxAttempts = withinWindow ? 5 : 1;
    let payload: unknown = null;
    let state: LineupState = "NOT_ANNOUNCED";
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      payload = await saGet(`/football/matches/${matchId}/lineups`);
      state = classifyLineupState(payload);
      lastLineupState = state;
      const tag = `attempt ${attempt + 1}/${maxAttempts}`;
      if (state === "POPULATED") {
        console.log(
          `[S3 lineups] State 3 LINEUP CONFIRMED (TheStatsAPI) for matchId=${matchId} ` +
            `(${match.home} vs ${match.away}, ${tag}) — starting_xi populated for both teams.`,
        );
        return payload;
      }
      if (state === "PROPAGATING") {
        console.warn(
          `[S3 lineups] State 2 LINEUP PROPAGATING for matchId=${matchId} ` +
            `(${match.home} vs ${match.away}, ${tag}) — confirmed=true but starting_xi ` +
            `still empty (data being ingested). Trying API-Football fallback now.`,
        );
      } else {
        console.warn(
          `[S3 lineups] State 1 LINEUP NOT ANNOUNCED for matchId=${matchId} ` +
            `(${match.home} vs ${match.away}, ${tag}) — endpoint 404, team sheet not ` +
            `published yet. Trying API-Football fallback now.`,
        );
      }

      // Fire the API-Football fallback on EVERY attempt (not just after the full
      // 5×60s TheStatsAPI retry burst). If a lineup lands in API-Football first,
      // we pick it up immediately instead of blocking for up to 5 minutes.
      const afEarly = await fetchApiFootballLineupFallback(match);
      if (afEarly) {
        lastLineupState = "POPULATED";
        console.log(
          `[S3 lineups] State 3 LINEUP CONFIRMED via API-Football fallback for ` +
            `${match.home} vs ${match.away} (TheStatsAPI was ${state}, ${tag}).`,
        );
        return afEarly;
      }

      if (attempt < maxAttempts - 1) await sleep(60000);
    }

    // Neither TheStatsAPI nor API-Football produced a populated XI within the
    // retry window. Carry the resolved state in the thrown message so the caller
    // knows whether this is NOT_ANNOUNCED vs PROPAGATING.
    throw new Error(
      state === "PROPAGATING"
        ? "LINEUP PROPAGATING — confirmed=true but starting_xi never populated; API-Football fallback also empty."
        : "LINEUP NOT ANNOUNCED — lineups not published yet (404); API-Football fallback also empty.",
    );
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
      label: "Fetching referee profile (S7)... (10/11)",
    });
    if (!fixtureVerified) {
      record("7", "Referee profile", "BLOCKED", undefined, blockOpts.blockReason);
    } else if (!tryLoadCache("7")) {
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
  }


  // 8: predictions (blocked on C1 mismatch; else skipped if near daily cap)
  await runStep(
    "8",
    "Fetching predictions... (11/11)",
    () => afGet(`/predictions?fixture=${match.id}`, afKey),
    {
      ...blockOpts,
      skip: counterWarning,
      skipReason: "Skipped — daily API budget near limit (>=85).",
    },
  );
  // (CALL 9 + CALL 9B moved earlier — see just after CALL 5 injuries. FIX 5:
  //  odds must be fetched BEFORE the CALL 6 lineup retry loop, which can block
  //  up to 5×60s inside T-90 and leave odds stale.)


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
            note: "Dead-rubber checks use PRE-MATCH standings reconstructed as of each analysed fixture's kickoff ISO (FIX 6). all_groups_standings below are the FINAL table, shown only as the name→id/group directory.",
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
  if (!fixtureVerified) {
    record("10", "Next-round bracket", "BLOCKED", undefined, blockOpts.blockReason);
  } else if (tryLoadCache("10")) {
    /* reused fresh cached bracket */
  } else if (counterWarning) {
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

  // Gap 6 — penalty-shootout summary from the S0 lookup (final_score based).
  const finalRef = statsApiRef as StatsApiMatchRef | null;
  const wentToPenalties = finalRef?.wentToPenalties ?? false;
  const ps = finalRef?.penaltyShootout ?? null;
  const penaltyShootoutNote =
    wentToPenalties && ps
      ? `WENT TO PENALTIES — normal time ${ps.normal_time.home}-${ps.normal_time.away}, ` +
        `shootout ${ps.shootout_score.home}-${ps.shootout_score.away}, ` +
        `aggregate (final_score) ${ps.aggregate.home}-${ps.aggregate.away}. ` +
        `Detected via score.final_score differing from normal-time score (NOT a status string).`
      : "Not a penalty shootout (final_score matches normal-time score, or no final_score present).";

  // Detach the debug sink so later non-debug runs are not recorded into it.
  debugSink = null;

  // Resolved lineup state for this run. If CALL 6 succeeded the XI is populated;
  // otherwise use the last state observed during the retry loop so the UI can
  // tell NOT_ANNOUNCED apart from ANNOUNCED-BUT-PROPAGATING.
  const lineupState: LineupState = lineupResolved ? "POPULATED" : lastLineupState;
  const lineupInfo = LINEUP_STATE_INFO[lineupState];

  return {
    callResults,
    lineupResolved,
    lineupState,
    succeeded,
    emptyOrFailed,
    failedCalls,
    warning: lineupResolved
      ? null
      : `⚠️ ${lineupInfo.label}. ${lineupInfo.note}`,
    counterWarning,
    debugEntries: opts.debug ? localDebug : undefined,
    deadRubberTriggered,
    deadRubberFlagged,
    historicalCaveatEligible,
    historicalCaveatReason,
    wentToPenalties,
    penaltyShootoutNote,
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
    const state = classifyLineupState(payload);
    if (state !== "POPULATED") {
      const info = LINEUP_STATE_INFO[state];
      console.warn(
        `[S3 lineups/refetch] ${info.label} for matchId=${matchId} ` +
          `(${match.home} vs ${match.away}) — trying API-Football fallback.`,
      );
      // Per spec: State 2 PROPAGATING (or 1 NOT_ANNOUNCED) → fall back to AF.
      const afLineup = await fetchApiFootballLineupFallback(match);
      if (afLineup) {
        console.log(
          `[S3 lineups/refetch] State 3 LINEUP CONFIRMED via API-Football fallback ` +
            `for ${match.home} vs ${match.away}.`,
        );
        return {
          key: "6",
          label: "Confirmed lineups",
          status: "SUCCESS",
          data: replaceNulls(afLineup),
        };
      }
      return {
        key: "6",
        label: "Confirmed lineups",
        status: "EMPTY",
        error: `${info.label} — ${info.note} API-Football fallback also empty.`,
      };
    }
    console.log(
      `[S3 lineups/refetch] State 3 LINEUP CONFIRMED (TheStatsAPI) for matchId=${matchId} ` +
        `(${match.home} vs ${match.away}).`,
    );
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
  currentDebugCall = "C1";
  let response: unknown;
  try {
    response = await afGet(
      `/fixtures?league=1&season=2026&date=${DEBUG_FIXTURE_DATE}`,
    );
  } finally {
    currentDebugCall = null;
  }
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
    statusShort: "FT",
    minutesUntilKickoff,
    status: computeStatus(minutesUntilKickoff, false),
    // Debug fixtures are finished matches; never block the debug pipeline on it.
    blocked: false,
  };
}


// ============================================================================
// GRANULAR CALL PANEL — display mapping + per-call retry
// ============================================================================
//
// The normal Run Calls flow shows one row per logical call. These specs map the
// user-facing call ids (C1..C10 / S0..S7) to the internal callResults keys the
// pipeline records, plus mandatory/optional classification and the retry key.

export interface CallDisplaySpec {
  id: string; // "C1", "C3", ..., "S7"
  label: string; // "Fixtures", "Head to Head", ...
  api: "API-FOOTBALL" | "THESTATSAPI";
  keys: string[]; // internal callResults keys this row aggregates
  mandatory: boolean;
  retryKey?: string; // passed to retrySingleCall (undefined = not retryable)
}

export const CALL_DISPLAY_SPECS: CallDisplaySpec[] = [
  // ---- API-FOOTBALL ----
  { id: "C1", label: "Fixture verification", api: "API-FOOTBALL", keys: ["C1"], mandatory: true, retryKey: "C1" },
  { id: "C3", label: "Head to Head", api: "API-FOOTBALL", keys: ["3"], mandatory: false, retryKey: "3" },
  { id: "C4", label: "Last 5 Form", api: "API-FOOTBALL", keys: ["4-1", "4-2", "4-3"], mandatory: false, retryKey: "4" },
  { id: "C5", label: "Injuries", api: "API-FOOTBALL", keys: ["5"], mandatory: false, retryKey: "5" },
  { id: "C7", label: "Referee", api: "API-FOOTBALL", keys: ["7"], mandatory: false, retryKey: "7" },
  { id: "C8", label: "Predictions", api: "API-FOOTBALL", keys: ["8"], mandatory: false, retryKey: "8" },
  { id: "C9A", label: "Stake Odds", api: "API-FOOTBALL", keys: ["9"], mandatory: true, retryKey: "9" },
  { id: "C10", label: "Bracket", api: "API-FOOTBALL", keys: ["10"], mandatory: false, retryKey: "10" },
  // ---- THESTATSAPI ----
  { id: "S0", label: "Match Lookup", api: "THESTATSAPI", keys: ["S0"], mandatory: true, retryKey: "S0" },
  { id: "S2A", label: "Home Stats", api: "THESTATSAPI", keys: ["2A"], mandatory: true, retryKey: "2A" },
  { id: "S2B", label: "Away Stats", api: "THESTATSAPI", keys: ["2B"], mandatory: true, retryKey: "2B" },
  { id: "S3", label: "Lineups", api: "THESTATSAPI", keys: ["6"], mandatory: false, retryKey: "6" },
  { id: "S5", label: "Pinnacle Odds", api: "THESTATSAPI", keys: ["9B"], mandatory: false, retryKey: "9B" },
  { id: "S6", label: "Standings", api: "THESTATSAPI", keys: ["S6"], mandatory: false, retryKey: "S6" },
  { id: "S7", label: "Referee Detail", api: "THESTATSAPI", keys: ["7"], mandatory: false, retryKey: "7" },
];

export type DisplayStatus =
  | "SUCCESS"
  | "CACHED"
  | "EMPTY"
  | "PROPAGATING"
  | "FAILED"
  | "BLOCKED"
  | "MISMATCH"
  | "PENDING";

export function deriveDisplayStatus(
  spec: CallDisplaySpec,
  callResults: Record<string, CallResult>,
): DisplayStatus {
  // C1 is the fixture-verification step. Reflect the real result: VERIFIED
  // (SUCCESS), MISMATCH (hard FAILED), or PENDING before it has run. An
  // inconclusive EMPTY still shows SUCCESS-ish (verified with caveat).
  if (spec.id === "C1") {
    const c1 = callResults["C1"];
    if (!c1) return "PENDING";
    if (c1.status === "FAILED") return "MISMATCH";
    if (c1.status === "EMPTY") return "EMPTY";
    return c1.cached ? "CACHED" : "SUCCESS";
  }

  // Lineups are never cached and their absence is expected/optional — surface
  // PROPAGATING vs EMPTY rather than a hard FAILED.
  if (spec.id === "S3") {
    const c6 = callResults["6"];
    if (!c6) return "PENDING";
    if (c6.status === "SUCCESS") return "SUCCESS";
    const err = (c6.error ?? "").toUpperCase();
    return err.includes("PROPAGATING") ? "PROPAGATING" : "EMPTY";
  }

  const results = spec.keys.map((k) => callResults[k]).filter(Boolean) as CallResult[];
  if (results.length === 0) return "PENDING";
  // A BLOCKED dependent call (C1 mismatch) takes precedence over any other state.
  if (results.some((r) => r.status === "BLOCKED")) return "BLOCKED";
  if (results.some((r) => r.status === "FAILED")) return "FAILED";

  const withData = results.filter((r) => r.status === "SUCCESS");
  if (withData.length === 0) return "EMPTY";
  return withData.every((r) => r.cached) ? "CACHED" : "SUCCESS";
}

export interface CallPanelRow {
  spec: CallDisplaySpec;
  status: DisplayStatus;
  // Most recent fetch time across this row's underlying results (for "12m ago").
  fetchedAt?: number;
  // Raw recorded results for always-on transparency (raw response blocks).
  results: CallResult[];
}

export interface CallPanelSummary {
  rows: CallPanelRow[];
  totalCount: number;
  successCount: number;
  cachedCount: number;
  mandatoryReady: boolean;
  notReadyMandatory: string[]; // display ids of mandatory calls that never ran or hard-failed
  emptyMandatory: string[]; // display ids of mandatory calls that ran but returned no data
  failedOptional: string[]; // display ids of optional calls that FAILED
}

export function buildCallPanelSummary(
  callResults: Record<string, CallResult>,
): CallPanelSummary {
  const rows: CallPanelRow[] = CALL_DISPLAY_SPECS.map((spec) => {
    const results = spec.keys
      .map((k) => callResults[k])
      .filter(Boolean) as CallResult[];
    const times = results
      .map((r) => r.fetchedAt)
      .filter((t): t is number => typeof t === "number");
    return {
      spec,
      status: deriveDisplayStatus(spec, callResults),
      fetchedAt: times.length ? Math.max(...times) : undefined,
      results,
    };
  });

  // A mandatory call is "ready" once it has actually run — SUCCESS, CACHED, or
  // EMPTY (ran but no data, e.g. odds not posted yet for tomorrow's match).
  // Only a call that never ran (PENDING) or hard-failed (FAILED/BLOCKED/MISMATCH)
  // blocks analysis. Claude tolerates NOT_AVAILABLE for empty inputs.
  const ready = (s: DisplayStatus) =>
    s === "SUCCESS" || s === "CACHED" || s === "EMPTY";
  const successCount = rows.filter((r) => r.status === "SUCCESS").length;
  const cachedCount = rows.filter((r) => r.status === "CACHED").length;

  const notReadyMandatory = rows
    .filter((r) => r.spec.mandatory && !ready(r.status))
    .map((r) => r.spec.id);
  const emptyMandatory = rows
    .filter((r) => r.spec.mandatory && r.status === "EMPTY")
    .map((r) => r.spec.id);
  const failedOptional = rows
    .filter((r) => !r.spec.mandatory && r.status === "FAILED")
    .map((r) => r.spec.id);

  return {
    rows,
    totalCount: rows.length,
    successCount,
    cachedCount,
    mandatoryReady: notReadyMandatory.length === 0,
    notReadyMandatory,
    emptyMandatory,
    failedOptional,
  };
}


/**
 * Re-run a SINGLE logical call for a match and return the updated callResults
 * entries to merge into the existing collection. Successful/empty results are
 * written to the per-call cache (lineups excepted). No other call is touched.
 */
export async function retrySingleCall(
  match: AnalysedMatch,
  retryKey: string,
): Promise<Record<string, CallResult>> {
  const out: Record<string, CallResult> = {};
  const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

  const rec = (
    key: string,
    label: string,
    status: CallStatus,
    data?: unknown,
    error?: string,
  ) => {
    const validated = data !== undefined ? replaceNulls(data) : undefined;
    const fetchedAt = Date.now();
    out[key] = { key, label, status, data: validated, error, cached: false, fetchedAt };
    if (status !== "FAILED" && status !== "SKIPPED" && status !== "BLOCKED") {
      writeCallCache(match.id, key, { key, label, status, data: validated, error, fetchedAt });
    }
  };

  const counterWarning = getApiCallCount() >= WARNING_THRESHOLD;
  const counterCritical = getApiCallCount() >= CRITICAL_THRESHOLD;

  // Any API-Football id-dependent retry must re-confirm the C1 fixture
  // verification first. A cached SUCCESS is trusted; a cached FAILED (or a fresh
  // mismatch) blocks the retry so a wrong fixture id can never re-enter via the
  // individual retry path.
  const AF_ID_DEPENDENT = new Set(["3", "4", "5", "7", "8", "9", "10"]);
  const ensureVerifiedForRetry = async (): Promise<boolean> => {
    const cached = readCallCache(match.id, "C1");
    if (cached?.status === "SUCCESS" || cached?.status === "EMPTY") return true;
    if (cached?.status === "FAILED") return false;
    try {
      const v = await verifyFixtureById(match);
      if (v.reason.startsWith("INCONCLUSIVE")) {
        rec("C1", "Fixture verification", "EMPTY", v, v.reason);
        return true;
      }
      rec("C1", "Fixture verification", v.verified ? "SUCCESS" : "FAILED", v, v.reason);
      return v.verified;
    } catch {
      return true; // inconclusive network error → don't block
    }
  };

  if (AF_ID_DEPENDENT.has(retryKey)) {
    const ok = await ensureVerifiedForRetry();
    if (!ok) {
      const reason = "C1 fixture mismatch, cannot proceed. Retry C1 first.";
      // Mark every id-dependent surface for this key BLOCKED.
      const map: Record<string, [string, string][]> = {
        "3": [["3", "Head-to-head"]],
        "4": [["4-1", "Recent form (home)"], ["4-2", "Recent form (away)"], ["4-3", "Recent form batch"]],
        "5": [["5", "Injuries"]],
        "7": [["7", "Referee profile"]],
        "8": [["8", "Predictions"]],
        "9": [["9", "Stake odds"]],
        "10": [["10", "Next-round bracket"]],
      };
      for (const [k, l] of map[retryKey] ?? [[retryKey, retryKey]]) {
        rec(k, l, "BLOCKED", undefined, reason);
      }
      return out;
    }
  }

  currentDebugCall = retryKey;
  try {
    switch (retryKey) {
      case "C1": {
        try {
          const v = await verifyFixtureById(match);
          if (v.reason.startsWith("INCONCLUSIVE")) {
            rec("C1", "Fixture verification", "EMPTY", v, v.reason);
          } else {
            rec("C1", "Fixture verification", v.verified ? "SUCCESS" : "FAILED", v, v.reason);
          }
        } catch (e) {
          rec("C1", "Fixture verification", "EMPTY", undefined, `Verification inconclusive — ${msg(e)}`);
        }
        break;
      }
      case "3": {
        try {
          const r = await afGet(`/fixtures/headtohead?h2h=${match.homeId}-${match.awayId}&last=10`);
          rec("3", "Head-to-head", isEmptyResponse(r) ? "EMPTY" : "SUCCESS", r);
        } catch (e) {
          rec("3", "Head-to-head", "FAILED", undefined, msg(e));
        }
        break;
      }
      case "4": {
        let homeIds: number[] = [];
        let awayIds: number[] = [];
        try {
          const r1 = await afGet(`/fixtures?team=${match.homeId}&last=5&league=1&season=2026`);
          rec("4-1", "Recent form (home)", isEmptyResponse(r1) ? "EMPTY" : "SUCCESS", r1);
          homeIds = extractArray(r1)
            .map((f) => getField(getField(f, ["fixture"]), ["id"]))
            .filter((id): id is number => typeof id === "number");
        } catch (e) {
          rec("4-1", "Recent form (home)", "FAILED", undefined, msg(e));
        }
        try {
          const r2 = await afGet(`/fixtures?team=${match.awayId}&last=5&league=1&season=2026`);
          rec("4-2", "Recent form (away)", isEmptyResponse(r2) ? "EMPTY" : "SUCCESS", r2);
          awayIds = extractArray(r2)
            .map((f) => getField(getField(f, ["fixture"]), ["id"]))
            .filter((id): id is number => typeof id === "number");
        } catch (e) {
          rec("4-2", "Recent form (away)", "FAILED", undefined, msg(e));
        }
        try {
          const ids = Array.from(new Set([...homeIds, ...awayIds])).slice(0, 10);
          const r3 = ids.length ? await afGet(`/fixtures?ids=${ids.join("-")}`) : null;
          rec("4-3", "Recent form batch", isEmptyResponse(r3) ? "EMPTY" : "SUCCESS", r3);
        } catch (e) {
          rec("4-3", "Recent form batch", "FAILED", undefined, msg(e));
        }
        break;
      }
      case "5": {
        try {
          const r = await afGet(`/injuries?fixture=${match.id}`);
          rec("5", "Injuries", isEmptyResponse(r) ? "EMPTY" : "SUCCESS", r);
        } catch (e) {
          rec("5", "Injuries", "FAILED", undefined, msg(e));
        }
        break;
      }
      case "8": {
        try {
          const r = await afGet(`/predictions?fixture=${match.id}`);
          rec("8", "Predictions", isEmptyResponse(r) ? "EMPTY" : "SUCCESS", r);
        } catch (e) {
          rec("8", "Predictions", "FAILED", undefined, msg(e));
        }
        break;
      }
      case "9": {
        try {
          let stakeId: string | null =
            typeof window !== "undefined"
              ? window.localStorage.getItem("stake_bookmaker_id")
              : null;
          if (!stakeId) {
            const bookmakers = await afGet(`/odds/bookmakers`);
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
          );
          rec("9", "Odds (Stake)", isEmptyResponse(afOdds) ? "EMPTY" : "SUCCESS", { stakeOdds: afOdds });
        } catch (e) {
          rec("9", "Odds (Stake)", "FAILED", undefined, msg(e));
        }
        break;
      }
      case "10": {
        const nr = nextRound(match.round);
        if (!nr) {
          rec("10", "Next-round bracket", "SKIPPED", undefined, "Could not derive next round.");
          break;
        }
        try {
          const r = await afGet(`/fixtures?league=1&season=2026&round=${encodeURIComponent(nr)}`);
          if (isEmptyResponse(r)) {
            rec("10", "Next-round bracket", "EXPECTED_EMPTY", r, `Next round (${nr}) fixtures not yet determined.`);
          } else {
            rec("10", "Next-round bracket", "SUCCESS", r);
          }
        } catch (e) {
          rec("10", "Next-round bracket", "FAILED", undefined, msg(e));
        }
        break;
      }
      case "S0": {
        try {
          const ref = await resolveStatsApiMatch(match.home, match.away, match.kickoffUtc);
          if (!ref) {
            rec("S0", "TheStatsAPI match lookup", "FAILED", undefined, "STATSAPI_ID_NOT_FOUND — no match resolved.");
          } else {
            rec("S0", "TheStatsAPI match lookup", "SUCCESS", {
              match_id: ref.id,
              home_team: { id: ref.homeTeamId, name: ref.homeTeamName },
              away_team: { id: ref.awayTeamId, name: ref.awayTeamName },
              went_to_penalties: ref.wentToPenalties,
              penalty_shootout: ref.penaltyShootout,
            });
          }
        } catch (e) {
          rec("S0", "TheStatsAPI match lookup", "FAILED", undefined, msg(e));
        }
        break;
      }
      case "2A":
      case "2B": {
        const isHome = retryKey === "2A";
        const label = isHome ? "Home team stats (TheStatsAPI)" : "Away team stats (TheStatsAPI)";
        try {
          const ref = await resolveStatsApiMatch(match.home, match.away, match.kickoffUtc);
          const teamId = isHome ? ref?.homeTeamId : ref?.awayTeamId;
          if (!teamId) {
            rec(retryKey, label, "FAILED", undefined, "No TheStatsAPI team id from match lookup.");
            break;
          }
          const raw = await saGet(`/football/teams/${teamId}/stats?season_id=${STATSAPI_SEASON_ID}`);
          if (isEmptyResponse(raw)) {
            rec(retryKey, label, "FAILED", undefined, "No TheStatsAPI team stats returned.");
          } else {
            rec(retryKey, label, "SUCCESS", { teamId, extracted: extractTeamStats(raw), raw });
          }
        } catch (e) {
          rec(retryKey, label, "FAILED", undefined, msg(e));
        }
        break;
      }
      case "6": {
        // Lineups: reuse the dedicated refetch path (never cached).
        const result = await refetchLineups(match);
        out["6"] = { ...result, cached: false, fetchedAt: Date.now() };
        break;
      }
      case "9B": {
        try {
          // Pinnacle-or-empty via API-Football bookmaker=4 (see collectMatchData
          // C9B). No TheStatsAPI, no retail fallback.
          const c9aBookmakerId =
            typeof window !== "undefined"
              ? window.localStorage.getItem("stake_bookmaker_id")
              : null;
          if (c9aBookmakerId && String(c9aBookmakerId) === String(PINNACLE_BOOKMAKER_ID)) {
            rec("9B", "Pinnacle odds (API-Football bookmaker=4)", "EMPTY", undefined, "C9A already resolved to Pinnacle (bookmaker=4); C9B would duplicate the same book.");
            break;
          }
          const oddsJson = await afGet(
            `/odds?fixture=${match.id}&bookmaker=${PINNACLE_BOOKMAKER_ID}`,
          );
          const summary = buildPinnacleSummaryFromApiFootball(oddsJson);
          if (!summary || !summary.is_pinnacle) {
            rec("9B", "Pinnacle odds (API-Football bookmaker=4)", "EMPTY", { source: "API-Football bookmaker=4" }, "Pinnacle unavailable — no bookmaker=4 markets for this fixture.");
          } else {
            const stakeRoot = readCallCache(match.id, "9")?.data as { stakeOdds?: unknown } | undefined;
            const gapCheck = buildStakeGapCheck(stakeRoot?.stakeOdds, summary.markets);
            rec("9B", "Pinnacle odds (API-Football bookmaker=4)", "SUCCESS", {
              matchId: match.id,
              bookmaker: summary.bookmaker,
              is_pinnacle: summary.is_pinnacle,
              source: "API-Football bookmaker=4",
              markets: summary.markets,
              gap_check: gapCheck,
              note:
                "Pinnacle PRICE LEVELS from API-Football bookmaker=4. opening null / movement UNKNOWN (no line-movement history from any source for this competition — treat as 'no data', not 'zero'). pinnacle_gap_check compares C9A retail vs Pinnacle (single snapshot each); gap_pct = (retail/pinnacle - 1) * 100.",
            });
          }
        } catch (e) {
          rec("9B", "Pinnacle odds (API-Football bookmaker=4)", "EMPTY", undefined, `Pinnacle data unavailable — ${msg(e)}`);
        }
        break;
      }
      case "7": {
        try {
          let profile: RefereeProfile | null = null;
          const ref = await resolveStatsApiMatch(match.home, match.away, match.kickoffUtc);
          const matchId = ref?.id ?? null;
          if (matchId) {
            try {
              const refJson = await saGet(`/football/matches/${matchId}/referee`);
              const refNode = getField(getField(refJson, ["data"]) ?? refJson, ["referee"]);
              profile = buildRefereeProfileFromStatsApi(refNode);
            } catch (e) {
              console.warn("[retry] S7 referee endpoint failed", e);
            }
          }
          const afName = (typeof profile?.referee === "string" && profile.referee) || match.referee;
          if (afName && !counterCritical) {
            try {
              const afProfile = await buildRefereeProfile(afName, !counterWarning);
              if (afProfile) {
                if (!profile) {
                  profile = afProfile;
                } else {
                  profile.avg_fouls_per_game = afProfile.avg_fouls_per_game;
                  profile.penalties_awarded = afProfile.penalties_awarded;
                  if (profile.avg_yellow_cards_per_game === "NOT_AVAILABLE") {
                    profile.avg_yellow_cards_per_game = afProfile.avg_yellow_cards_per_game;
                  }
                }
              }
            } catch (e) {
              console.warn("[retry] CALL 7 API-Football referee enrichment failed", e);
            }
          }
          if (profile) {
            rec("7", "Referee profile (S7 + API-Football)", "SUCCESS", profile);
          } else {
            rec("7", "Referee profile", "EMPTY", undefined, "Referee strictness UNKNOWN — no referee resolved.");
          }
        } catch (e) {
          rec("7", "Referee profile", "EMPTY", undefined, `Referee profile unavailable — ${msg(e)}`);
        }
        break;
      }
      case "S6": {
        try {
          const homeList = readCallCache(match.id, "4-1")?.data ?? null;
          const awayList = readCallCache(match.id, "4-2")?.data ?? null;
          const homeNeeds = parseLast5(homeList, match.homeId).some((f) => f.is_group_stage);
          const awayNeeds = parseLast5(awayList, match.awayId).some((f) => f.is_group_stage);
          let all: AllStandings | null = null;
          if (homeNeeds || awayNeeds) all = await getStatsApiAllStandings();
          const homeDr = await computeTeamDeadRubber(homeList, match.homeId, all);
          const awayDr = await computeTeamDeadRubber(awayList, match.awayId, all);
          const flagged = homeDr.adjustment.dead_rubber_count + awayDr.adjustment.dead_rubber_count;
          rec("4-deadrubber", "Recency-weighted & dead-rubber-adjusted form", "SUCCESS", {
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
            dead_rubber_count: flagged,
          });
          const triggered = homeDr.triggered || awayDr.triggered;
          if (!triggered) {
            rec("S6", "All-groups standings (dead-rubber check)", "SKIPPED", undefined, "NOT TRIGGERED — all last-5 fixtures are knockout stage.");
          } else {
            rec("S6", "All-groups standings (dead-rubber check)", all && all.groupRows.length ? "SUCCESS" : "EMPTY", {
              note: "Dead-rubber checks use PRE-MATCH standings reconstructed as of each fixture's kickoff ISO (FIX 6).",
              wc2026_qualification: WC2026_QUALIFICATION,
              all_groups_standings: all?.groupRows ?? [],
              home: { dead_rubbers_flagged: homeDr.adjustment.dead_rubber_count, reason: homeDr.reason },
              away: { dead_rubbers_flagged: awayDr.adjustment.dead_rubber_count, reason: awayDr.reason },
            });
          }
        } catch (e) {
          rec("S6", "All-groups standings (dead-rubber check)", "EMPTY", undefined, `Dead-rubber check unavailable — ${msg(e)}`);
        }
        break;
      }
      default: {
        console.warn(`[retry] unknown retry key: ${retryKey}`);
      }
    }
  } finally {
    currentDebugCall = null;
  }

  return out;
}
