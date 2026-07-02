import {
  extractStakeMarkets,
  buildCallPanelSummary,
  type CollectionResult,
  type CallResult,
  type LineupState,
} from "@/lib/analyse";
import type {
  AnalysisResult,
  Absence,
  ConfidenceAdjustment,
} from "@/lib/analysisResult";
import type {
  PersistedCallSummaryRow,
  PersistedKeyExtracts,
} from "@/lib/resultCache";
import { normalizeAnalysisResult } from "@/lib/normalizeAnalysisResult";

// The Section-3 "Copy Run Report" flattens the entire current match analysis
// into one plain-text, clipboard-friendly block. Everything is defensive:
// any missing value renders as "N/A" — never `undefined`/`null`.

/** The per-call collection map produced by the data pipeline (state.collection). */
export type CallStatusMap = CollectionResult | null;

/** The Claude output enriched with app-side computed numbers (calculate.ts). */
export type EnrichedResult = AnalysisResult | null | undefined;

/** Fixture-level metadata (from the AnalysedMatch) for the CALL DATA header. */
export interface RunReportMeta {
  home?: string | null;
  away?: string | null;
  venueName?: string | null;
  venueCity?: string | null;
  referee?: string | null;
  fixtureId?: number | null;
}

const NA = "N/A";
const RULE = "─────────────────────────────────";

// Logical call keys grouped by upstream API. Mirrors the debug-report counting
// in analyse.ts (API-Football = 8 counted calls, TheStatsAPI = 7).
const AF_KEYS = ["3", "4-1", "4-2", "4-3", "5", "8", "9A", "10"];
const SA_KEYS = ["S0", "2A", "2B", "6", "6B", "9B", "7"];

function na(v: unknown): string {
  if (v === undefined || v === null) return NA;
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : NA;
  const s = String(v).trim();
  return s.length ? s : NA;
}

function num(v: unknown, digits?: number): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return NA;
  return typeof digits === "number" ? v.toFixed(digits) : String(v);
}

function signed(v: unknown, digits = 3): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return NA;
  return `${v >= 0 ? "+" : ""}${v.toFixed(digits)}`;
}

function lineupText(state: LineupState | undefined, resolved: boolean): string {
  switch (state) {
    case "POPULATED":
      return "CONFIRMED";
    case "PROPAGATING":
      return resolved ? "PROPAGATING (fallback: API-Football)" : "PROPAGATING";
    case "NOT_ANNOUNCED":
      return resolved ? "PENDING (fallback: API-Football)" : "PENDING";
    default:
      return NA;
  }
}

function statusList(cr: Record<string, CallResult>, status: string): string {
  const hits = Object.values(cr)
    .filter((c) => c?.status === status)
    .map((c) => c?.label || c?.key)
    .filter(Boolean);
  return hits.length ? hits.join(", ") : "none";
}

function countSucceeded(cr: Record<string, CallResult>, keys: string[]): number {
  return keys.filter((k) => cr[k]?.status === "SUCCESS").length;
}

function fmtAdjustments(adj: ConfidenceAdjustment[] | undefined): string {
  if (!Array.isArray(adj) || adj.length === 0) return NA;
  return adj
    .map((a) => `${na(a?.type)}: ${signed(a?.delta)}`)
    .join(", ");
}

function fmtAbsence(a: Absence): string {
  const goals = num(a?.gap_score_inputs?.actual_goals);
  const assists = num(a?.gap_score_inputs?.actual_assists);
  return [
    `  ${na(a?.player)} (${na(a?.team)}) ${na(a?.classification)}`,
    `    goals:${goals} assists:${assists}`,
    `    replacement: ${na(a?.replacement)}`,
  ].join("\n");
}


// ─────────────────────────────────────────────────────────────
// CALL DATA helpers — pull the ACTUAL extracted values out of each
// call's stored `data` payload (not just success/fail). All access is
// defensive: unknown shapes fall back to N/A.
// ─────────────────────────────────────────────────────────────

/** First-present key lookup on an unknown object. */
function field(obj: unknown, keys: string[]): unknown {
  if (obj == null || typeof obj !== "object") return undefined;
  const rec = obj as Record<string, unknown>;
  for (const k of keys) {
    if (rec[k] !== undefined && rec[k] !== null) return rec[k];
  }
  return undefined;
}

/** Pull an array out of common API envelopes ({response|data|results}) or a raw array. */
function asArray(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    for (const f of ["response", "data", "results"]) {
      if (Array.isArray(obj[f])) return obj[f] as unknown[];
    }
  }
  return [];
}

function callData(cr: Record<string, CallResult>, key: string): unknown {
  const c = cr[key];
  return c && c.status === "SUCCESS" ? (c.data ?? null) : null;
}

/** Value like "1.85" from an outcome name inside an extractStakeMarkets market. */
function stakePrice(
  markets: Record<string, Array<{ value: string; odd: string }>> | undefined,
  label: string,
  valueMatch: (v: string) => boolean,
): string {
  const rows = markets?.[label];
  if (!Array.isArray(rows)) return NA;
  const hit = rows.find((row) => valueMatch(String(row.value).toLowerCase()));
  return hit && hit.odd ? na(hit.odd) : NA;
}

/** Sum of implied probabilities (1/odd) for 1X2 → overround, e.g. "1.062". */
function stakeOverround(
  markets: Record<string, Array<{ value: string; odd: string }>> | undefined,
): string {
  const rows = markets?.["1X2 (Match Winner)"];
  if (!Array.isArray(rows) || !rows.length) return NA;
  let sum = 0;
  let counted = 0;
  for (const row of rows) {
    const o = Number.parseFloat(row.odd);
    if (Number.isFinite(o) && o > 0) {
      sum += 1 / o;
      counted++;
    }
  }
  return counted ? sum.toFixed(3) : NA;
}

interface PinOutcome {
  name?: string;
  current?: number | null;
  opening?: number | null;
  movement_pct?: number | null;
  signal?: string;
}
interface PinMarket {
  market?: string;
  outcomes?: PinOutcome[];
}

/** Format a single Pinnacle/retail outcome movement line. */
function fmtPinLine(o: PinOutcome): string {
  const mv =
    typeof o?.movement_pct === "number" && Number.isFinite(o.movement_pct)
      ? `${o.movement_pct >= 0 ? "+" : ""}${o.movement_pct}%`
      : NA;
  return `      ${na(o?.name)}: opening ${num(o?.opening)} last ${num(
    o?.current,
  )} movement ${mv} ${na(o?.signal)}`;
}

/** First N starter names from one side of a lineup payload. */
function starters(side: unknown, n: number): string[] {
  const xi = field(side, ["starting_xi", "startingXi", "startingXI", "lineup"]);
  const arr = Array.isArray(xi) ? xi : [];
  return arr
    .slice(0, n)
    .map((p) => {
      const name = field(p, ["name"]) ?? field(field(p, ["player"]), ["name"]);
      return typeof name === "string" && name.trim() ? name.trim() : null;
    })
    .filter((x): x is string => !!x);
}

/**
 * Build the CALL DATA section: the actual extracted values from every logical
 * call. Sits between PIPELINE and CONFIDENCE in the report.
 */
function buildCallData(
  cr: Record<string, CallResult>,
  lineupState: LineupState | undefined,
  lineupResolved: boolean,
  meta: RunReportMeta,
): string[] {
  const out: string[] = [];
  const p = (s = "") => out.push(s);

  p("CALL DATA");
  p("─────────────────");

  // ── C1 — Fixture verification ─────────────────────────────
  const c1 = cr["C1"]?.data as
    | {
        verified?: boolean;
        fixtureId?: number;
        actualHome?: string | null;
        actualAway?: string | null;
        expectedHome?: string;
        expectedAway?: string;
      }
    | null
    | undefined;
  const home = na(meta.home ?? c1?.actualHome ?? c1?.expectedHome);
  const away = na(meta.away ?? c1?.actualAway ?? c1?.expectedAway);
  const venue =
    meta.venueName || meta.venueCity
      ? [meta.venueName, meta.venueCity].filter(Boolean).join(", ")
      : NA;
  p(`C1  Fixture: ${home} vs ${away}`);
  p(`    Venue: ${venue}`);
  p(`    Referee: ${na(meta.referee)}`);
  p(`    Fixture ID: ${na(c1?.fixtureId ?? meta.fixtureId)}`);
  p(`    Verified: ${c1?.verified ? "YES" : c1 ? "NO" : NA}`);

  // ── C3 — Head to Head ─────────────────────────────────────
  const h2h = callData(cr, "3");
  const h2hCount = asArray(h2h).length;
  if (cr["3"]?.status === "SUCCESS" && h2hCount > 0) {
    p(`C3  H2H: ${h2hCount} meetings`);
  } else {
    p("C3  H2H: EMPTY — no competitive H2H");
  }

  // ── C4 — Recency-weighted / dead-rubber-adjusted form ─────
  const dr = cr["4-deadrubber"]?.data as
    | {
        home?: Record<string, unknown>;
        away?: Record<string, unknown>;
      }
    | null
    | undefined;
  const drHome = dr?.home ?? {};
  const drAway = dr?.away ?? {};
  p("C4  Home last 5:");
  p(`      goals avg: ${na(field(drHome, ["adjusted_goals_avg"]))}`);
  p(`      shots avg: ${na(field(drHome, ["adjusted_shots_avg"]))}`);
  p(`      dead rubber discounted: ${na(field(drHome, ["dead_rubber_count"]))}`);
  p("    Away last 5:");
  p(`      goals avg: ${na(field(drAway, ["adjusted_goals_avg"]))}`);
  p(`      shots avg: ${na(field(drAway, ["adjusted_shots_avg"]))}`);
  p(`      dead rubber discounted: ${na(field(drAway, ["dead_rubber_count"]))}`);

  // ── C5 — Injuries ─────────────────────────────────────────
  const injuries = asArray(callData(cr, "5"));
  if (injuries.length) {
    p(`C5  Injuries: ${injuries.length} absences`);
    for (const it of injuries) {
      const player =
        field(it, ["player"]) && typeof field(it, ["player"]) === "object"
          ? field(field(it, ["player"]), ["name"])
          : field(it, ["player"]);
      const team = field(field(it, ["team"]), ["name"]) ?? field(it, ["team"]);
      const reason =
        field(field(it, ["player"]), ["reason", "type"]) ??
        field(it, ["reason", "type"]);
      p(`    ${na(player)} (${na(team)}) — ${na(reason)}`);
    }
  } else {
    p("C5  Injuries: none reported");
  }

  // ── C7 — Referee (resolved profile) ───────────────────────
  const ref = cr["7"]?.data as
    | {
        referee?: string;
        matches_officiated?: number;
        avg_yellow_cards_per_game?: number | string;
        source?: string;
        career_totals?: {
          games?: number | null;
          yellow_cards?: number | null;
        };
      }
    | null
    | undefined;
  if (ref && cr["7"]?.status === "SUCCESS") {
    const avgY = ref.avg_yellow_cards_per_game;
    const avgYNum = typeof avgY === "number" ? avgY : NaN;
    p(`C7  Referee: ${na(ref.referee)}`);
    p(
      `    avg yellows: ${na(avgY)} over ${na(ref.matches_officiated)} games`,
    );
    p(`    strictness score: ${num(avgYNum, 2)}`);
    p(
      `    ${
        Number.isFinite(avgYNum)
          ? avgYNum >= 4
            ? "HIGH"
            : avgYNum >= 3
              ? "MEDIUM"
              : "LOW"
          : NA
      }`,
    );
    const src = String(ref.source ?? "");
    p(
      `    Source: ${
        /thestatsapi/i.test(src)
          ? "TheStatsAPI S7"
          : /api-football/i.test(src)
            ? "API-Football C7"
            : "UNKNOWN"
      }`,
    );
  } else {
    p("C7  Referee: UNKNOWN");
    p("    Source: UNKNOWN");
  }

  // ── C8 — Predictions ──────────────────────────────────────
  const predArr = asArray(callData(cr, "8"));
  const pred = field(predArr[0], ["predictions"]);
  if (pred) {
    const pct = field(pred, ["percent"]);
    const goals = field(pred, ["goals"]);
    p(
      `C8  Predictions: home ${na(field(pct, ["home"]))} draw ${na(
        field(pct, ["draw"]),
      )} away ${na(field(pct, ["away"]))}`,
    );
    p(
      `    Poisson goals: home ${na(field(goals, ["home"]))} away ${na(
        field(goals, ["away"]),
      )}`,
    );
  } else {
    p("C8  Predictions: EMPTY — skipped/failed");
  }

  // ── C9A — Stake odds ──────────────────────────────────────
  const stakeRoot = cr["9"]?.data as { stakeOdds?: unknown } | null | undefined;
  const stake = extractStakeMarkets(stakeRoot?.stakeOdds ?? null);
  const sm = stake?.markets;
  p("C9A Stake odds:");
  p(
    `    Home: ${stakePrice(sm, "1X2 (Match Winner)", (v) =>
      v.includes("home"),
    )} Draw: ${stakePrice(sm, "1X2 (Match Winner)", (v) =>
      v.includes("draw"),
    )} Away: ${stakePrice(sm, "1X2 (Match Winner)", (v) => v.includes("away"))}`,
  );
  p(
    `    Over 2.5: ${stakePrice(sm, "Over/Under 2.5 Goals", (v) =>
      v.includes("over"),
    )} Under 2.5: ${stakePrice(sm, "Over/Under 2.5 Goals", (v) =>
      v.includes("under"),
    )}`,
  );
  p(
    `    BTTS Yes: ${stakePrice(sm, "Both Teams To Score", (v) =>
      v.includes("yes"),
    )} No: ${stakePrice(sm, "Both Teams To Score", (v) => v.includes("no"))}`,
  );
  p(
    `    Corners 9.5 over: ${stakePrice(sm, "Corners Over/Under 9.5", (v) =>
      v.includes("over"),
    )}`,
  );
  p("    Cards 3.5 over: N/A");
  p(`    Overround: ${stakeOverround(sm)}`);

  // ── C9B — Pinnacle / retail odds + line movement ──────────
  const pin = cr["9B"]?.data as
    | { bookmaker?: string; is_pinnacle?: boolean; markets?: PinMarket[] }
    | null
    | undefined;
  p("C9B Pinnacle odds:");
  if (pin && cr["9B"]?.status === "SUCCESS") {
    const source = pin.is_pinnacle
      ? "PINNACLE"
      : String(pin.bookmaker ?? "").toUpperCase() || "EMPTY";
    p(`    Source: ${source}`);
    if (!pin.is_pinnacle) {
      p(
        `    ⚠ NOTE: Pinnacle unavailable — ${
          pin.bookmaker ?? "retail book"
        } returned as fallback. adjustEVForPinnacleGap did not fire. ev_confidence set to MEDIUM.`,
      );
    }
    const markets = Array.isArray(pin.markets) ? pin.markets : [];
    const oneX2 = markets.find((m) =>
      /1x2/i.test(String(m?.market ?? "")),
    );
    const ou = markets.find((m) =>
      /goal/i.test(String(m?.market ?? "")),
    );
    const lines: PinOutcome[] = [];
    for (const o of oneX2?.outcomes ?? []) lines.push(o);
    const over25 = (ou?.outcomes ?? []).find((o) =>
      /over 2\.5/i.test(String(o?.name ?? "")),
    );
    if (over25) lines.push(over25);
    if (lines.length) {
      for (const o of lines) p(fmtPinLine(o));
    } else {
      p("    No odds data returned");
    }
  } else {
    p("    Source: EMPTY");
    p("    No odds data returned");
  }

  // ── S2A — Home season stats ───────────────────────────────
  const s2a = field(cr["2A"]?.data, ["extracted"]) as
    | Record<string, unknown>
    | undefined;
  const emitTeamStats = (id: string, label: string, s: Record<string, unknown> | undefined, teamName?: string | null) => {
    p(`${id}  ${label}:`);
    if (s) {
      const gf = field(s, ["goals_for"]);
      const ga = field(s, ["goals_against"]);
      const gd =
        typeof gf === "number" && typeof ga === "number" ? gf - ga : undefined;
      p(
        `    ${na(teamName)}: ${na(field(s, ["wins"]))}W ${na(
          field(s, ["draws"]),
        )}D ${na(field(s, ["losses"]))}L`,
      );
      p(`    GF:${na(gf)} GA:${na(ga)} GD:${gd === undefined ? NA : gd}`);
      p(`    Form: ${na(field(s, ["form"]))}`);
      p(`    Position: ${na(field(s, ["position"]))}`);
    } else {
      p(`    ${na(teamName)}: EMPTY — no season stats returned`);
    }
  };
  emitTeamStats("S2A", "Home team season stats", s2a, meta.home);

  // ── S2B — Away season stats ───────────────────────────────
  const s2b = field(cr["2B"]?.data, ["extracted"]) as
    | Record<string, unknown>
    | undefined;
  emitTeamStats("S2B", "Away team season stats", s2b, meta.away);

  // ── S3 — Lineups ──────────────────────────────────────────
  const lineup = callData(cr, "6");
  const lnode = (field(lineup, ["data"]) ?? lineup) as unknown;
  const lState =
    lineupState === "POPULATED"
      ? "CONFIRMED"
      : lineupState === "PROPAGATING"
        ? "PROPAGATING"
        : lineupState === "NOT_ANNOUNCED"
          ? "PENDING"
          : NA;
  const lSource = String(field(lnode, ["source"]) ?? "");
  const lTag = lineupResolved
    ? /api-football/i.test(lSource)
      ? "CONFIRMED — fallback: API-Football"
      : "CONFIRMED"
    : lState;
  const homeSide = field(lnode, ["home"]);
  const awaySide = field(lnode, ["away"]);
  const homeStarters = starters(homeSide, 3);
  const awayStarters = starters(awaySide, 3);
  p("S3  Lineups:");
  p(`    Home: ${na(field(homeSide, ["formation"]))} — ${lTag}`);
  p(`      ${homeStarters.length ? homeStarters.join(", ") : "not available"}`);
  p(`    Away: ${na(field(awaySide, ["formation"]))} — ${lTag}`);
  p(`      ${awayStarters.length ? awayStarters.join(", ") : "not available"}`);

  // ── S7 — Referee (TheStatsAPI career totals) ──────────────
  const career = ref?.career_totals;
  const careerGames = field(career, ["games"]);
  const careerYellows = field(career, ["yellow_cards"]);
  p("S7  Referee (TheStatsAPI):");
  if (ref && career && typeof careerGames === "number" && careerGames > 0) {
    const avg =
      typeof careerYellows === "number"
        ? (careerYellows / careerGames).toFixed(2)
        : NA;
    p(`    ${na(ref.referee)} — ${na(careerGames)} career games`);
    p(`    yellows: ${na(careerYellows)} (${avg} per game)`);
  } else {
    p("    EMPTY — used API-Football C7 instead");
  }

  return out;
}

// ─────────────────────────────────────────────────────────────
// FIX 2 — reload-safe summary builders + renderers. The live collection
// (state.collection) is wiped on reload, so we persist a compact call
// summary + key extracts and rebuild PIPELINE/CALL DATA from them.
// ─────────────────────────────────────────────────────────────

/** Build the persist-safe call summary from a live call-results map. */
export function buildPersistedCallSummary(
  callResults: Record<string, CallResult>,
): PersistedCallSummaryRow[] {
  return buildCallPanelSummary(callResults).rows.map((row) => ({
    id: row.spec.id,
    label: row.spec.label,
    status: row.status,
    cached: row.status === "CACHED",
  }));
}

/** Build the persist-safe key extracts from the live collection. */
export function buildKeyExtracts(callStatuses: CallStatusMap): PersistedKeyExtracts {
  const cr = callStatuses?.callResults ?? {};
  const stakeRoot = cr["9"]?.data as { stakeOdds?: unknown } | null | undefined;
  const odds9A =
    cr["9"]?.status === "SUCCESS"
      ? extractStakeMarkets(stakeRoot?.stakeOdds ?? null)
      : null;
  const pin = cr["9B"]?.data as
    | { bookmaker?: string; is_pinnacle?: boolean }
    | null
    | undefined;
  const ref = cr["7"]?.data as
    | { referee?: string; avg_yellow_cards_per_game?: number | string }
    | null
    | undefined;
  return {
    odds9A,
    bookmaker9B: cr["9B"]?.status === "SUCCESS" ? (pin?.bookmaker ?? null) : null,
    isPinnacle9B: !!pin?.is_pinnacle,
    lineupState: lineupText(
      callStatuses?.lineupState,
      callStatuses?.lineupResolved ?? false,
    ),
    refereeName: cr["7"]?.status === "SUCCESS" ? (ref?.referee ?? null) : null,
    refereeYellows:
      cr["7"]?.status === "SUCCESS"
        ? (ref?.avg_yellow_cards_per_game ?? null)
        : null,
  };
}

const SAVED_HEADER = "(from saved run — reload-safe summary)";
const isReady = (s: string) => s === "SUCCESS" || s === "CACHED";

/** PIPELINE section rebuilt from a persisted call summary. */
function pipelineFromSaved(
  summary: PersistedCallSummaryRow[],
  keyExtracts: PersistedKeyExtracts | undefined,
  dataQuality: string,
): string[] {
  const af = summary.filter((r) => r.id.startsWith("C"));
  const sa = summary.filter((r) => r.id.startsWith("S"));
  const afOk = af.filter((r) => isReady(r.status)).length;
  const saOk = sa.filter((r) => isReady(r.status)).length;
  const failed = summary.filter((r) => r.status === "FAILED").map((r) => r.label);
  const empty = summary.filter((r) => r.status === "EMPTY").map((r) => r.label);
  return [
    `PIPELINE ${SAVED_HEADER}`,
    `API-Football: ${afOk}/${af.length} succeeded`,
    `TheStatsAPI: ${saOk}/${sa.length} succeeded`,
    `Failed: ${failed.length ? failed.join(", ") : "none"}`,
    `Empty: ${empty.length ? empty.join(", ") : "none"}`,
    `Lineups: ${na(keyExtracts?.lineupState)}`,
    `Data quality: ${na(dataQuality)}`,
    "",
  ];
}

/** CALL DATA section rebuilt from persisted key extracts. */
function callDataFromSaved(
  keyExtracts: PersistedKeyExtracts | undefined,
  meta: RunReportMeta,
): string[] {
  const out: string[] = [`CALL DATA ${SAVED_HEADER}`, "─────────────────"];
  const home = na(meta.home);
  const away = na(meta.away);
  out.push(`C1  Fixture: ${home} vs ${away}`);
  out.push(`    Fixture ID: ${na(meta.fixtureId)}`);

  // C7 referee
  out.push(`C7  Referee: ${na(keyExtracts?.refereeName ?? meta.referee)}`);
  out.push(`    avg yellows: ${na(keyExtracts?.refereeYellows)}`);

  // C9A stake odds (same extract shape as live)
  const sm = keyExtracts?.odds9A?.markets;
  out.push("C9A Stake odds:");
  out.push(
    `    Home: ${stakePrice(sm, "1X2 (Match Winner)", (v) =>
      v.includes("home"),
    )} Draw: ${stakePrice(sm, "1X2 (Match Winner)", (v) =>
      v.includes("draw"),
    )} Away: ${stakePrice(sm, "1X2 (Match Winner)", (v) => v.includes("away"))}`,
  );
  out.push(
    `    Over 2.5: ${stakePrice(sm, "Over/Under 2.5 Goals", (v) =>
      v.includes("over"),
    )} Under 2.5: ${stakePrice(sm, "Over/Under 2.5 Goals", (v) =>
      v.includes("under"),
    )}`,
  );
  out.push(`    Overround: ${stakeOverround(sm)}`);

  // C9B pinnacle source
  out.push("C9B Pinnacle odds:");
  if (keyExtracts?.bookmaker9B || keyExtracts?.isPinnacle9B) {
    const source = keyExtracts?.isPinnacle9B
      ? "PINNACLE"
      : String(keyExtracts?.bookmaker9B ?? "").toUpperCase() || "EMPTY";
    out.push(`    Source: ${source}`);
    if (!keyExtracts?.isPinnacle9B) {
      out.push(
        `    ⚠ NOTE: Pinnacle unavailable — ${
          keyExtracts?.bookmaker9B ?? "retail book"
        } returned as fallback.`,
      );
    }
  } else {
    out.push("    Source: EMPTY");
  }

  // Lineups (state only — full XI not persisted)
  out.push("S3  Lineups:");
  out.push(`    State: ${na(keyExtracts?.lineupState)}`);
  return out;
}


  match: string,
  round: string,
  kickoff: string,
  callStatuses: CallStatusMap,
  analysisResult: EnrichedResult,
  claudeRaw: string,
  lastRunAt: Date,
  meta: RunReportMeta = {},
): string {
  const cr = callStatuses?.callResults ?? {};
  const r = normalizeAnalysisResult(analysisResult);

  const L: string[] = [];
  const push = (s = "") => L.push(s);

  // ── Header ──────────────────────────────────────────────
  push("EDGE RUN REPORT");
  push(`${na(match)} — ${na(round)} — ${na(kickoff)}`);
  push(
    `Run at: ${
      lastRunAt instanceof Date && !Number.isNaN(lastRunAt.getTime())
        ? lastRunAt.toISOString()
        : NA
    }`,
  );
  push(RULE);

  // ── Pipeline ────────────────────────────────────────────
  push("PIPELINE");
  push(`API-Football: ${countSucceeded(cr, AF_KEYS)}/8 succeeded`);
  push(`TheStatsAPI: ${countSucceeded(cr, SA_KEYS)}/7 succeeded`);
  push(`Failed: ${statusList(cr, "FAILED")}`);
  push(`Empty: ${statusList(cr, "EMPTY")}`);
  push(
    `Lineups: ${lineupText(
      callStatuses?.lineupState,
      callStatuses?.lineupResolved ?? false,
    )}`,
  );
  push(`Data quality: ${na(r.data_quality)}`);
  push(
    `Dead-rubber discounted: ${
      typeof callStatuses?.deadRubberFlagged === "number"
        ? callStatuses.deadRubberFlagged
        : 0
    } fixtures`,
  );
  push();

  // ── Call data (actual extracted values) ─────────────────
  for (const line of buildCallData(
    cr,
    callStatuses?.lineupState,
    callStatuses?.lineupResolved ?? false,
    meta,
  )) {
    push(line);
  }
  push(RULE);
  push();


  const cs = r.confidence_scores;
  push("CONFIDENCE");
  push(
    `Raw: ${na(
      cs.dimension_weighted_raw ?? cs.confidence_inputs?.dimension_weighted_raw,
    )}`,
  );
  push(
    `Adjustments: ${fmtAdjustments(
      cs.adjustments ?? cs.confidence_inputs?.adjustments,
    )}`,
  );
  push(`Final: ${na(cs.final_confidence)}`);
  push(`Ensemble: ${na(r.ensemble_check?.alignment)}`);
  push(`Pinnacle: ${r.pinnacle_available ? "YES" : "NO"}`);
  push();

  // ── Dimension weights ───────────────────────────────────
  const dw = r.dimension_weights;
  const dwv = r.dimension_weights_validation;
  push("DIMENSION WEIGHTS");
  if (dw) {
    push(
      `D1:${num(dw.D1)} D2:${num(dw.D2)} D3:${num(dw.D3)} D4:${num(dw.D4)}`,
    );
    const sum = [dw.D1, dw.D2, dw.D3, dw.D4, dw.D5, dw.D6].reduce(
      (acc, n) => acc + (typeof n === "number" ? n : 0),
      0,
    );
    push(`D5:${num(dw.D5)} D6:${num(dw.D6)} Sum:${num(sum, 2)}`);
  } else {
    push(`D1:${NA} D2:${NA} D3:${NA} D4:${NA}`);
    push(`D5:${NA} D6:${NA} Sum:${NA}`);
  }
  if (dwv?.sum_valid) {
    push("VALID");
  } else {
    const reason =
      dwv?.mismatch_flags && dwv.mismatch_flags.length
        ? dwv.mismatch_flags.join("; ")
        : dwv?.validation_ran === false
          ? "validation did not run"
          : "sum invalid";
    push(`MISMATCH — ${reason}`);
  }
  push();

  // ── Absences ────────────────────────────────────────────
  push("ABSENCES");
  const absences = r.player_intelligence?.absences ?? [];
  if (absences.length) {
    for (const a of absences) push(fmtAbsence(a));
  } else {
    push("  none");
  }
  const onNotice = r.player_intelligence?.suspension_served_eligible;
  push(
    `On notice: ${
      Array.isArray(onNotice) && onNotice.length ? onNotice.join(", ") : "none"
    }`,
  );
  push();

  // ── Bet 1 — straight bet ────────────────────────────────
  const pctOf = (v: unknown, bankroll: unknown): string => {
    const kb = typeof bankroll === "number" && Number.isFinite(bankroll) ? bankroll : 50;
    return `${na(v)}% of $${kb}`;
  };
  const evPct = (v: unknown): string => {
    if (typeof v !== "number" || !Number.isFinite(v)) return NA;
    return `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`;
  };
  const fmtStraight = (bet: (typeof r)["bet_1"], label: string) => {
    push(label);
    if (bet?.active) {
      push(`  ${na(bet.market)}: ${na(bet.selection)}`);
      push(`  Stake:${na(bet.stake)} | Odds:${num(bet.odds)}`);
      push(
        `  EV:${evPct(bet.ev)} | Kelly:${pctOf(
          bet.kelly_result?.fractional_kelly_pct,
          bet.kelly_inputs?.bankroll,
        )}`,
      );
      if (bet.stake_label) push(`  📍 ${bet.stake_label}`);
    } else {
      push(`  INACTIVE — ${na(bet?.skip_reason)}`);
      push(`  EV was: ${signed(bet?.ev)}`);
    }
    push();
  };
  fmtStraight(r.bet_1, "BET 1 — STRAIGHT BET");
  fmtStraight(r.bet_2, "BET 2 — STRAIGHT BET");

  // ── Bet 3 — 3-leg SGP ───────────────────────────────────
  const b3 = r.bet_3 ?? {};
  const pe = b3.parlay_ev_inputs ?? {};
  push("BET 3 — 3-LEG ACCUMULATOR (SGP)");
  if (b3.active) {
    const legs = b3.legs ?? [];
    if (legs.length) {
      legs.forEach((leg, i) => {
        push(
          `  Leg ${leg?.leg_number ?? i + 1}: ${na(leg?.market)} — ${na(
            leg?.selection,
          )} @ ${num(leg?.odds)}`,
        );
        if (leg?.stake_label) push(`    📍 ${leg.stake_label}`);
      });
    } else {
      push("  Legs: N/A");
    }
    push(`  Combined SGP odds:${num(b3.combined_odds_sgp)}`);
    push(
      `  Stake:${na(b3.stake)} | Return:~${na(
        b3.returns?.potential_return_realistic,
      )}`,
    );
    push(`  p_joint:${na(pe.p_joint)} | Parlay EV:${evPct(b3.parlay_ev)}`);
  } else {
    push(`  INACTIVE — ${na(b3.skip_reason)}`);
    push(`  Parlay EV was: ${signed(b3.parlay_ev)}`);
  }
  push();

  // ── Bet 4 — jackpot ─────────────────────────────────────
  const b4 = r.bet_4 ?? {};
  const jSignals =
    Array.isArray(b4.class_c_signals) && b4.class_c_signals.length
      ? b4.class_c_signals.join(", ")
      : "none";
  push("BET 4 — JACKPOT ACCUMULATOR");
  if (b4.active) {
    const legs = b4.legs ?? [];
    if (legs.length) {
      legs.forEach((leg, i) => {
        push(
          `  Leg ${leg?.leg_number ?? i + 1}: ${na(leg?.market)} — ${na(
            leg?.selection,
          )} @ ${num(leg?.odds)}`,
        );
        if (leg?.stake_label) push(`    📍 ${leg.stake_label}`);
      });
    } else {
      push("  Legs: N/A");
    }
    push(`  CLASS C signals: ${jSignals}`);
    push(`  Odds:${num(b4.combined_odds)} Stake:${na(b4.stake)}`);
    push(`  EV:${evPct(b4.jackpot_ev)}`);
  } else {
    push(`  Not available — ${na(b4.skip_reason)}`);
    push(`  Signals found: ${jSignals}`);
  }
  push();

  push(`STAKED: ${na(r.total_staked)}`);
  push(`UNALLOCATED: ${na(r.unallocated_stake)}`);
  push();

  // ── Key risk / analyst note ─────────────────────────────
  push("KEY RISK");
  push(na(r.key_risk_flag));
  push();
  push("ANALYST NOTE");
  push(na(r.analyst_note));
  push();

  // ── Validation ──────────────────────────────────────────
  const mp = r.model_probabilities;
  push("VALIDATION");
  push(
    `Probs sum: ${num(mp?.raw_sum)}% ${
      mp?.was_normalized === undefined
        ? NA
        : mp.was_normalized
          ? "(normalized)"
          : "(not normalized)"
    }`,
  );
  push(
    `Ensemble overwrite: ${na(r.ensemble_check?.alignment)}`,
  );
  if (dwv) {
    if (dwv.validation_ran === false) push("Weights: NOT RUN");
    else if (dwv.sum_valid) push("Weights: PASSED");
    else push("Weights: MISMATCH");
    if (dwv.mismatch_flags && dwv.mismatch_flags.length) {
      push(dwv.mismatch_flags.join("; "));
    }
  } else {
    push("Weights: NOT RUN");
  }
  push();

  // ── Raw Claude JSON ─────────────────────────────────────
  push("RAW CLAUDE JSON");
  push(claudeRaw && claudeRaw.trim().length ? claudeRaw.trim() : NA);
  push(RULE);
  push("END EDGE RUN REPORT");

  return L.join("\n");
}
