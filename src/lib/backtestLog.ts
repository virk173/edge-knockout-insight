/**
 * Backtesting log storage + analytics.
 *
 * Log entries are persisted in localStorage under "edge_wc2026_log".
 * Each analysis output that contains a `log_entry` is appended (never
 * overwritten). Outcomes are tracked per recommendation so that the summary
 * panel can compare win rates across ensemble-alignment buckets.
 */

import {
  readClosingCapture,
  writeClosingCapture,
  matchClosingPrice,
  computeClv,
} from "@/lib/clv";
import type { CalibrationSample } from "@/lib/calibration";
import type {
  AnalysisResult,
  StraightBet,
  TierLeg,
} from "@/lib/analysisResult";

export const LOG_STORAGE_KEY = "edge_wc2026_log";

export type Outcome = "PENDING" | "WON" | "LOST" | "PUSH" | "VOID";

export interface LogRecommendation {
  tier?: number | string;
  market?: string;
  selection?: string;
  odds?: number;
  stake?: string;
  model_probability?: number;
  // PRE-calibration model probability. REQUIRED for the λ fit: fitting on the
  // calibrated value creates a feedback loop (λ fit on λ-shrunk inputs but
  // applied to raw inputs → drifts toward 1.0 and disables calibration).
  model_probability_raw?: number;
  ev?: number;
  confidence?: number;
  ensemble_alignment?: string;
  sharp_signal?: string;
  outcome: Outcome;
  // Strict-signal regime: paper bets never touch the bankroll on settlement.
  paper?: boolean;
  // Shadow Pick: the best-available candidate logged as a $0 paper bet when
  // nothing qualified. Feeds CLV + calibration, excluded from the edge verdict.
  shadow?: boolean;
  // Discretionary "I placed this" bet: real money, tracked to the dollar, but
  // EXCLUDED from the model's edge-verdict aggregates.
  action_bet?: boolean;
  // Ledger id of the bankroll settlement created for an action bet (so a later
  // outcome change can reverse/re-apply it). Set by the UI on settlement.
  settled_ledger_id?: string;
  // Closing Line Value (see clv.ts). Populated by settleClv().
  closing_odds?: number;
  closing_source?: string;
  clv_pct?: number;
}

export interface LogEntry {
  id: string;
  savedAt: string;
  match?: string;
  matchId?: number;
  date?: string;
  round?: string;
  notes?: string;
  recommendations: LogRecommendation[];
}

/** Shape of the `log_entry` field produced by Claude (defensive/optional). */
export interface RawLogEntry {
  match?: string;
  matchId?: number;
  date?: string;
  round?: string;
  notes?: string;
  recommendations?: Array<Partial<LogRecommendation>>;
}

/** Parse a stake string like "$20" or "$10.00" into a number. */
export function parseStake(stake?: string | number): number {
  if (typeof stake === "number") return Number.isFinite(stake) ? stake : 0;
  if (!stake) return 0;
  const n = Number.parseFloat(String(stake).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

/** EV realised: WON -> odds - 1, LOST -> -1, PUSH/VOID -> 0, PENDING -> null. */
export function computeEvRealised(rec: LogRecommendation): number | null {
  if (rec.outcome === "WON") {
    const odds = typeof rec.odds === "number" ? rec.odds : 0;
    return odds - 1;
  }
  if (rec.outcome === "LOST") return -1;
  if (rec.outcome === "PUSH" || rec.outcome === "VOID") return 0;
  return null;
}

/** Cycle a badge outcome PENDING -> WON -> LOST -> PUSH -> PENDING. (VOID is
 * settable programmatically but not part of the click cycle — pushes are the
 * common case: AH stake-returned, DNB draws.) */
export function cycleOutcome(outcome: Outcome): Outcome {
  if (outcome === "PENDING") return "WON";
  if (outcome === "WON") return "LOST";
  if (outcome === "LOST") return "PUSH";
  return "PENDING";
}

export type AlignmentBucket = "TRIPLE" | "MAJORITY" | "CONFLICT" | "OTHER";

export function normalizeAlignment(alignment?: string): AlignmentBucket {
  const s = (alignment ?? "").toUpperCase();
  if (s.includes("TRIPLE")) return "TRIPLE";
  if (s.includes("MAJORITY")) return "MAJORITY";
  if (s.includes("CONFLICT")) return "CONFLICT";
  return "OTHER";
}

function safeParse(raw: string | null): LogEntry[] {
  if (!raw) return [];
  try {
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data as LogEntry[];
  } catch {
    return [];
  }
}

export function getLogEntries(): LogEntry[] {
  if (typeof window === "undefined") return [];
  return safeParse(window.localStorage.getItem(LOG_STORAGE_KEY));
}

function writeLogEntries(entries: LogEntry[]): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(LOG_STORAGE_KEY, JSON.stringify(entries));
}

function makeId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Strip Claude's pre-computation placeholder so it can never reach the screen.
 * Numeric fields (ev/confidence) are already number-guarded below, but Claude
 * can also emit "PENDING_APP_COMPUTE" inside descriptive string fields
 * (ensemble_alignment, sharp_signal). Blank those out defensively.
 */
function sanitizeString(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  if (v.includes("PENDING_APP_COMPUTE")) return undefined;
  return v;
}

/**
 * Append a Claude `log_entry` to the persisted log. Returns the updated list.
 * Never overwrites existing entries.
 */
export function appendLogEntry(raw: RawLogEntry | null | undefined): LogEntry[] {
  const existing = getLogEntries();
  if (!raw || typeof raw !== "object") return existing;

  const recommendations: LogRecommendation[] = Array.isArray(raw.recommendations)
    ? raw.recommendations.map((r) => ({
        tier: r?.tier,
        market: r?.market,
        selection: r?.selection,
        odds: typeof r?.odds === "number" ? r.odds : undefined,
        stake: r?.stake,
        model_probability:
          typeof r?.model_probability === "number" ? r.model_probability : undefined,
        model_probability_raw:
          typeof r?.model_probability_raw === "number"
            ? r.model_probability_raw
            : undefined,
        // ev/confidence: only a real computed number is ever stored; the literal
        // "PENDING_APP_COMPUTE" string is a non-number and becomes undefined.
        ev: typeof r?.ev === "number" ? r.ev : undefined,
        confidence:
          typeof r?.confidence === "number" ? r.confidence : undefined,
        ensemble_alignment: sanitizeString(r?.ensemble_alignment),
        sharp_signal: sanitizeString(r?.sharp_signal),
        paper: r?.paper === true,
        shadow: r?.shadow === true,
        action_bet: r?.action_bet === true,
        settled_ledger_id: sanitizeString(r?.settled_ledger_id),
        closing_odds:
          typeof r?.closing_odds === "number" ? r.closing_odds : undefined,
        closing_source: sanitizeString(r?.closing_source),
        clv_pct: typeof r?.clv_pct === "number" ? r.clv_pct : undefined,
        // Honour an explicit outcome from the raw entry; default PENDING.
        outcome:
          r?.outcome === "WON" ||
          r?.outcome === "LOST" ||
          r?.outcome === "PUSH" ||
          r?.outcome === "VOID"
            ? r.outcome
            : "PENDING",
      }))
    : [];

  const entry: LogEntry = {
    id: makeId(),
    savedAt: new Date().toISOString(),
    match: raw.match,
    matchId: typeof raw.matchId === "number" ? raw.matchId : undefined,
    date: raw.date,
    round: raw.round,
    notes: raw.notes,
    recommendations,
  };

  const updated = [...existing, entry];
  writeLogEntries(updated);
  return updated;
}

/**
 * Build a log entry from the APP-ENRICHED analysis result — never from Claude's
 * raw `log_entry` (which can claim positive EV the app has already gated to
 * inactive). Every value comes from app-computed fields:
 *   - one recommendation per bet_1/bet_2/bet_3/bet_4 that is active OR paper.
 *     Fully inactive bets are EXCLUDED.
 *   - ev = app-computed ev / parlay_ev / jackpot_ev
 *   - model_probability = the CALIBRATED value (bet.model_probability / p_joint)
 *   - stake = the app-sized stake string
 *   - confidence = app final_confidence
 *   - ensemble_alignment = app ensemble_check.alignment
 * Claude's log_entry.notes text is preserved, prefixed "Claude note: ".
 * If zero bets qualify, an entry with recommendations: [] is still appended so
 * every analysed match is on record.
 */
export function buildLogEntryFromEnriched(
  result: AnalysisResult,
  opts: { matchId?: number } = {},
): LogEntry {
  const alignment = sanitizeString(result.ensemble_check?.alignment);
  const finalConfidence =
    typeof result.confidence_scores?.final_confidence === "number"
      ? result.confidence_scores.final_confidence
      : undefined;

  const legsSelection = (legs: TierLeg[] | undefined): string =>
    (legs ?? [])
      .map((l) => [l.market, l.selection].filter(Boolean).join(": "))
      .filter(Boolean)
      .join(" + ");

  const recs: LogRecommendation[] = [];

  const pushStraight = (bet: StraightBet | undefined, tier: number) => {
    if (!bet) return;
    // Exclude fully inactive bets: only active OR paper bets are logged.
    if (bet.active !== true && bet.paper_bet !== true) return;
    recs.push({
      tier,
      market: bet.market,
      selection: bet.selection,
      odds: typeof bet.odds === "number" ? bet.odds : undefined,
      stake: bet.stake, // app-sized Kelly stake string
      paper: bet.paper_bet === true,
      // CALIBRATED probability (calculate.ts overwrites model_probability with
      // the calibrated value; model_probability_raw keeps the pre-cal figure).
      model_probability:
        typeof bet.model_probability === "number"
          ? bet.model_probability
          : undefined,
      // RAW (pre-calibration) probability — this is what the λ fit consumes.
      model_probability_raw:
        typeof bet.model_probability_raw === "number"
          ? bet.model_probability_raw
          : undefined,
      ev: typeof bet.ev === "number" ? bet.ev : undefined, // APP-computed EV
      confidence: finalConfidence,
      ensemble_alignment: alignment,
      sharp_signal: sanitizeString(bet.pinnacle_check_note),
      outcome: "PENDING",
    });
  };

  pushStraight(result.bet_1, 1);
  pushStraight(result.bet_2, 2);

  const sgp = result.bet_3;
  if (sgp && (sgp.active === true || sgp.paper_bet === true)) {
    recs.push({
      tier: 3,
      market: sgp.bet_type ?? "Same Game Parlay (3-Leg Accumulator)",
      selection: legsSelection(sgp.legs),
      odds:
        typeof sgp.combined_odds_sgp === "number"
          ? sgp.combined_odds_sgp
          : undefined,
      stake: sgp.stake,
      paper: sgp.paper_bet === true,
      model_probability: typeof sgp.p_joint === "number" ? sgp.p_joint : undefined,
      ev: typeof sgp.parlay_ev === "number" ? sgp.parlay_ev : undefined,
      confidence: finalConfidence,
      ensemble_alignment: alignment,
      sharp_signal: undefined,
      outcome: "PENDING",
    });
  }

  const jack = result.bet_4;
  if (jack && (jack.active === true || jack.paper_bet === true)) {
    recs.push({
      tier: 4,
      market: jack.bet_type ?? "Jackpot Accumulator (4-5 Leg Parlay)",
      selection: legsSelection(jack.legs),
      odds: typeof jack.combined_odds === "number" ? jack.combined_odds : undefined,
      stake: jack.stake,
      paper: jack.paper_bet === true,
      model_probability: undefined,
      ev: typeof jack.jackpot_ev === "number" ? jack.jackpot_ev : undefined,
      confidence: finalConfidence,
      ensemble_alignment: alignment,
      sharp_signal: undefined,
      outcome: "PENDING",
    });
  }

  // ── SHADOW PICK ───────────────────────────────────────────────
  // If nothing qualified (recs empty) but calculate.ts flagged a shadow_pick,
  // log that single candidate as a $0 paper bet (shadow: true) so CLV +
  // calibration volume keeps growing. Excluded from bankroll + edge verdict.
  let shadowEv: number | undefined;
  if (recs.length === 0) {
    const shadowStraight = (bet: StraightBet | undefined, tier: number) => {
      if (!bet || bet.shadow_pick !== true) return false;
      shadowEv = typeof bet.ev === "number" ? bet.ev : undefined;
      recs.push({
        tier,
        market: bet.market,
        selection: bet.selection,
        odds: typeof bet.odds === "number" ? bet.odds : undefined,
        stake: "$0",
        paper: true,
        shadow: true,
        model_probability:
          typeof bet.model_probability === "number"
            ? bet.model_probability
            : undefined,
        model_probability_raw:
          typeof bet.model_probability_raw === "number"
            ? bet.model_probability_raw
            : undefined,
        ev: shadowEv,
        confidence: finalConfidence,
        ensemble_alignment: alignment,
        sharp_signal: sanitizeString(bet.pinnacle_check_note),
        outcome: "PENDING",
      });
      return true;
    };
    const done =
      shadowStraight(result.bet_1, 1) || shadowStraight(result.bet_2, 2);
    if (!done && sgp?.shadow_pick === true) {
      shadowEv = typeof sgp.parlay_ev === "number" ? sgp.parlay_ev : undefined;
      recs.push({
        tier: 3,
        market: sgp.bet_type ?? "Same Game Parlay (3-Leg Accumulator)",
        selection: legsSelection(sgp.legs),
        odds:
          typeof sgp.combined_odds_sgp === "number"
            ? sgp.combined_odds_sgp
            : undefined,
        stake: "$0",
        paper: true,
        shadow: true,
        model_probability: typeof sgp.p_joint === "number" ? sgp.p_joint : undefined,
        ev: shadowEv,
        confidence: finalConfidence,
        ensemble_alignment: alignment,
        outcome: "PENDING",
      });
    } else if (!done && jack?.shadow_pick === true) {
      shadowEv = typeof jack.jackpot_ev === "number" ? jack.jackpot_ev : undefined;
      recs.push({
        tier: 4,
        market: jack.bet_type ?? "Jackpot Accumulator (4-5 Leg Parlay)",
        selection: legsSelection(jack.legs),
        odds:
          typeof jack.combined_odds === "number" ? jack.combined_odds : undefined,
        stake: "$0",
        paper: true,
        shadow: true,
        model_probability: undefined,
        ev: shadowEv,
        confidence: finalConfidence,
        ensemble_alignment: alignment,
        outcome: "PENDING",
      });
    }
  }

  const isShadow = recs.length === 1 && recs[0].shadow === true;
  const claudeNote = sanitizeString(result.log_entry?.notes);
  const notes = isShadow
    ? `SHADOW — best available had no value (EV ${
        typeof shadowEv === "number" ? shadowEv.toFixed(3) : "—"
      })`
    : recs.length === 0
      ? "No qualifying bets — all EV negative or gated."
      : claudeNote
        ? `Claude note: ${claudeNote}`
        : undefined;

  return {
    id: makeId(),
    savedAt: new Date().toISOString(),
    match: result.match,
    matchId:
      typeof opts.matchId === "number"
        ? opts.matchId
        : typeof result.log_entry?.matchId === "number"
          ? result.log_entry.matchId
          : undefined,
    date: result.kickoff_UTC ?? result.log_entry?.date,
    round: result.round ?? result.log_entry?.round,
    notes,
    recommendations: recs,
  };
}

/**
 * Append an app-built log entry (from buildLogEntryFromEnriched) to the log.
 * Always appends — even a match with zero qualifying bets is recorded.
 */
export function appendEnrichedResult(
  result: AnalysisResult,
  opts: { matchId?: number } = {},
): LogEntry[] {
  const existing = getLogEntries();
  const entry = buildLogEntryFromEnriched(result, opts);
  const updated = [...existing, entry];
  writeLogEntries(updated);
  return updated;
}

/**
 * Input for a discretionary "I placed this" action bet. Real money — tracked to
 * the dollar and settled against the bankroll — but excluded from the MODEL's
 * edge-verdict aggregates so hunches never contaminate the edge measurement.
 */
export interface ActionBetInput {
  matchId?: number;
  match?: string;
  date?: string;
  round?: string;
  tier?: number | string;
  market?: string;
  selection?: string;
  odds?: number;
  stake?: number; // actual dollars staked
  model_probability?: number;
  ev?: number; // APP-computed EV (never Claude's)
  ensemble_alignment?: string;
}

/**
 * Append a single action bet. It is written as its own LogEntry (carrying the
 * matchId so CLV can settle against the closing capture) with one
 * action_bet-flagged recommendation.
 */
export function appendActionBet(input: ActionBetInput): LogEntry[] {
  const existing = getLogEntries();
  const rec: LogRecommendation = {
    tier: input.tier,
    market: input.market,
    selection: input.selection,
    odds:
      typeof input.odds === "number" && Number.isFinite(input.odds)
        ? input.odds
        : undefined,
    stake:
      typeof input.stake === "number" && Number.isFinite(input.stake)
        ? `$${input.stake}`
        : undefined,
    model_probability:
      typeof input.model_probability === "number"
        ? input.model_probability
        : undefined,
    ev: typeof input.ev === "number" ? input.ev : undefined,
    ensemble_alignment: sanitizeString(input.ensemble_alignment),
    action_bet: true,
    paper: false,
    outcome: "PENDING",
  };
  const entry: LogEntry = {
    id: makeId(),
    savedAt: new Date().toISOString(),
    match: input.match,
    matchId: typeof input.matchId === "number" ? input.matchId : undefined,
    date: input.date,
    round: input.round,
    notes: "💵 ACTION — user-placed discretionary bet (real money).",
    recommendations: [rec],
  };
  const updated = [...existing, entry];
  writeLogEntries(updated);
  return updated;
}

/** Patch arbitrary fields on a single recommendation (e.g. settled_ledger_id). */
export function updateRecommendation(
  entryId: string,
  recIndex: number,
  patch: Partial<LogRecommendation>,
): LogEntry[] {
  const entries = getLogEntries();
  const updated = entries.map((e) => {
    if (e.id !== entryId) return e;
    const recs = e.recommendations.map((r, i) =>
      i === recIndex ? { ...r, ...patch } : r,
    );
    return { ...e, recommendations: recs };
  });
  writeLogEntries(updated);
  return updated;
}

export function setRecommendationOutcome(
  entryId: string,
  recIndex: number,
  outcome: Outcome,
): LogEntry[] {
  const entries = getLogEntries();
  const updated = entries.map((e) => {
    if (e.id !== entryId) return e;
    const recs = e.recommendations.map((r, i) =>
      i === recIndex ? { ...r, outcome } : r,
    );
    return { ...e, recommendations: recs };
  });
  writeLogEntries(updated);
  return updated;
}

// ─────────────────────────────────────────────────────────────
// CLV settlement (see clv.ts)
// ─────────────────────────────────────────────────────────────
/**
 * Recompute CLV for every recommendation in an entry from the stored closing
 * capture. Idempotent — safe to run on every capture write and on tab mount.
 * Only fills clv_pct when a price is matched; never guesses.
 */
export function settleClv(entryId: string): LogEntry[] {
  const entries = getLogEntries();
  const updated = entries.map((e) => {
    if (e.id !== entryId) return e;
    return { ...e, recommendations: settleEntryRecs(e) };
  });
  writeLogEntries(updated);
  return updated;
}

/** Run settleClv over every entry (idempotent). Used on log-tab mount. */
export function settleClvAll(): LogEntry[] {
  const entries = getLogEntries();
  const updated = entries.map((e) => ({
    ...e,
    recommendations: settleEntryRecs(e),
  }));
  writeLogEntries(updated);
  return updated;
}

function settleEntryRecs(e: LogEntry): LogRecommendation[] {
  if (typeof e.matchId !== "number") return e.recommendations;
  const capture = readClosingCapture(e.matchId);
  if (!capture) return e.recommendations;
  return e.recommendations.map((r) => {
    if (typeof r.odds !== "number") return r;
    const closing = matchClosingPrice(capture, r.market ?? "", r.selection ?? "");
    if (!closing) return r;
    return {
      ...r,
      closing_odds: closing.odds,
      closing_source: closing.source,
      clv_pct: computeClv(r.odds, closing.odds),
    };
  });
}

/**
 * Store a MANUAL closing price for a single recommendation and re-settle CLV.
 * Writes a MANUAL capture keyed by the entry's matchId containing only this
 * selection (accumulating across calls), then recomputes clv_pct for the entry.
 */
export function setManualClosingOdds(
  entryId: string,
  recIndex: number,
  odds: number,
): LogEntry[] {
  const entries = getLogEntries();
  const entry = entries.find((e) => e.id === entryId);
  if (!entry || typeof entry.matchId !== "number") return entries;
  const rec = entry.recommendations[recIndex];
  if (!rec || !Number.isFinite(odds) || odds <= 0) return entries;

  // AUDIT FIX — merge into ANY existing capture, not just MANUAL ones. The
  // old MANUAL-only merge started from {} when the existing capture was
  // PINNACLE/STAKE and wrote to the same matchId+day key, obliterating the
  // full automatic capture (and orphaning every not-yet-settled rec for this
  // match, including shadow entries). Now the automatic markets are carried
  // over untouched; only the manually-entered selection is added/replaced,
  // tagged per-outcome as MANUAL so the carried-over prices keep reporting
  // their true source (matchClosingPrice reads outcome.source ?? capture
  // source).
  const existing = readClosingCapture(entry.matchId);
  const prices = existing?.prices ? { ...existing.prices } : {};
  const marketKey = rec.market ?? "Manual";
  const list = Array.isArray(prices[marketKey]) ? [...prices[marketKey]] : [];
  const selKey = rec.selection ?? "";
  const idx = list.findIndex(
    (o) => (o.selection ?? "").toLowerCase() === selKey.toLowerCase(),
  );
  const manualOutcome = { selection: selKey, odds, source: "MANUAL" as const };
  if (idx >= 0) list[idx] = manualOutcome;
  else list.push(manualOutcome);
  prices[marketKey] = list;

  writeClosingCapture({
    matchId: entry.matchId,
    capturedAt: Date.now(),
    minutesBeforeKickoff: existing?.minutesBeforeKickoff ?? 0,
    // Capture-level source stays the automatic capture's when one existed —
    // untagged (carried-over) outcomes inherit it; the manual outcome carries
    // its own MANUAL tag.
    source: existing && existing.source !== "MANUAL" ? existing.source : "MANUAL",
    prices,
  });
  return settleClv(entryId);
}

export function clearLog(): LogEntry[] {
  writeLogEntries([]);
  return [];
}

export function countRecommendations(entries: LogEntry[]): number {
  return entries.reduce((sum, e) => sum + e.recommendations.length, 0);
}

export interface AlignmentSummary {
  bucket: AlignmentBucket;
  bets: number;
  won: number;
  lost: number;
  winRate: number | null;
}

export interface LogSummary {
  totalRecommendations: number;
  totalStaked: number;
  totalReturned: number;
  roi: number | null;
  winRate: number | null;
  wonCount: number;
  lostCount: number;
  pendingCount: number;
  avgEv: number | null;
  avgConfidence: number | null;
  alignment: AlignmentSummary[];
}

export function computeSummary(entries: LogEntry[]): LogSummary {
  // MODEL performance only — action bets (discretionary) and shadow picks
  // ($0 volume markers) are excluded so they never distort ROI / win rate.
  const recs = entries
    .flatMap((e) => e.recommendations)
    .filter((r) => r.action_bet !== true && r.shadow !== true);

  let totalStaked = 0;
  let totalReturned = 0;
  let wonCount = 0;
  let lostCount = 0;
  let pendingCount = 0;
  let evSum = 0;
  let evCount = 0;
  let confSum = 0;
  let confCount = 0;

  // ROI is computed over SETTLED stakes only (EDGE-FIX tier 6). Including
  // PENDING stakes in the denominator dragged ROI down purely because bets
  // hadn't been decided yet.
  let settledStaked = 0;
  for (const r of recs) {
    const stake = parseStake(r.stake);
    totalStaked += stake;
    if (r.outcome === "WON") {
      wonCount += 1;
      settledStaked += stake;
      const odds = typeof r.odds === "number" ? r.odds : 0;
      totalReturned += stake * odds;
    } else if (r.outcome === "LOST") {
      lostCount += 1;
      settledStaked += stake;
    } else if (r.outcome === "PUSH" || r.outcome === "VOID") {
      // Settled-neutral: stake returned, excluded from win-rate numerator and
      // denominator (decided = won + lost only).
      settledStaked += stake;
      totalReturned += stake;
    } else {
      pendingCount += 1;
    }
    if (typeof r.ev === "number" && Number.isFinite(r.ev)) {
      evSum += r.ev;
      evCount += 1;
    }
    if (typeof r.confidence === "number" && Number.isFinite(r.confidence)) {
      confSum += r.confidence;
      confCount += 1;
    }
  }

  const decided = wonCount + lostCount;

  // Alignment breakdown.
  const buckets: AlignmentBucket[] = ["TRIPLE", "MAJORITY", "CONFLICT", "OTHER"];
  const alignment: AlignmentSummary[] = buckets
    .map((bucket) => {
      const bucketRecs = recs.filter(
        (r) => normalizeAlignment(r.ensemble_alignment) === bucket,
      );
      const won = bucketRecs.filter((r) => r.outcome === "WON").length;
      const lost = bucketRecs.filter((r) => r.outcome === "LOST").length;
      const d = won + lost;
      return {
        bucket,
        bets: bucketRecs.length,
        won,
        lost,
        winRate: d > 0 ? (won / d) * 100 : null,
      };
    })
    .filter((a) => a.bets > 0);

  return {
    totalRecommendations: recs.length,
    totalStaked,
    totalReturned,
    roi: settledStaked > 0 ? ((totalReturned - settledStaked) / settledStaked) * 100 : null,
    winRate: decided > 0 ? (wonCount / decided) * 100 : null,
    wonCount,
    lostCount,
    pendingCount,
    avgEv: evCount > 0 ? evSum / evCount : null,
    avgConfidence: confCount > 0 ? confSum / confCount : null,
    alignment,
  };
}

const CSV_HEADERS = [
  "match",
  "date",
  "round",
  "tier",
  "market",
  "selection",
  "odds",
  "stake",
  "model_probability",
  "ev",
  "confidence",
  "ensemble_alignment",
  "sharp_signal",
  "outcome",
  "ev_realised",
  "notes",
];

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function buildCsv(entries: LogEntry[]): string {
  const rows: string[] = [CSV_HEADERS.join(",")];
  for (const e of entries) {
    if (e.recommendations.length === 0) {
      rows.push(
        [
          e.match,
          e.date,
          e.round,
          "", "", "", "", "", "", "", "", "", "", "", "",
          e.notes,
        ]
          .map(csvCell)
          .join(","),
      );
      continue;
    }
    for (const r of e.recommendations) {
      const evRealised = computeEvRealised(r);
      rows.push(
        [
          e.match,
          e.date,
          e.round,
          r.tier,
          r.market,
          r.selection,
          r.odds,
          r.stake,
          r.model_probability,
          r.ev,
          r.confidence,
          r.ensemble_alignment,
          r.sharp_signal,
          r.outcome,
          evRealised === null ? "" : evRealised.toFixed(2),
          e.notes,
        ]
          .map(csvCell)
          .join(","),
      );
    }
  }
  return rows.join("\n");
}

export function downloadCsv(entries: LogEntry[]): void {
  if (typeof window === "undefined") return;
  const csv = buildCsv(entries);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `edge-wc2026-backtest-log-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ─────────────────────────────────────────────────────────────
// CLV aggregate summary
// ─────────────────────────────────────────────────────────────
export type ClvVerdict = "TOO_EARLY" | "EDGE" | "NEUTRAL" | "NEGATIVE";

export interface ClvGroupRow {
  bucket: AlignmentBucket;
  bets: number;
  avgClv: number | null;
  beat: number;
}

export interface ClvSummary {
  betsWithClv: number; // real + paper
  avgClv: number | null;
  beatCount: number;
  beatPct: number | null;
  byGroup: ClvGroupRow[];
  verdict: ClvVerdict;
  verdictText: string;
}

function allRecs(entries: LogEntry[]): LogRecommendation[] {
  return entries.flatMap((e) => e.recommendations);
}

export function computeClvSummary(entries: LogEntry[]): ClvSummary {
  // Edge-verdict aggregates measure the MODEL's edge only — action bets AND
  // shadow picks are excluded (verification #4). Only genuine model
  // recommendations (real + strict-signal paper) count toward the verdict.
  const recs = allRecs(entries).filter(
    (r) =>
      typeof r.clv_pct === "number" &&
      r.action_bet !== true &&
      r.shadow !== true,
  );
  const n = recs.length;
  const avg =
    n > 0 ? recs.reduce((s, r) => s + (r.clv_pct as number), 0) / n : null;
  const beatCount = recs.filter((r) => (r.clv_pct as number) > 0).length;
  const beatPct = n > 0 ? (beatCount / n) * 100 : null;

  const buckets: AlignmentBucket[] = ["TRIPLE", "MAJORITY", "CONFLICT", "OTHER"];
  const byGroup: ClvGroupRow[] = buckets
    .map((bucket) => {
      const g = recs.filter(
        (r) => normalizeAlignment(r.ensemble_alignment) === bucket,
      );
      const gAvg =
        g.length > 0
          ? g.reduce((s, r) => s + (r.clv_pct as number), 0) / g.length
          : null;
      return {
        bucket,
        bets: g.length,
        avgClv: gAvg,
        beat: g.filter((r) => (r.clv_pct as number) > 0).length,
      };
    })
    .filter((r) => r.bets > 0);

  let verdict: ClvVerdict = "TOO_EARLY";
  let verdictText = "Too early — need 20+";
  if (n >= 20 && avg !== null && beatPct !== null) {
    if (avg >= 1 && beatPct >= 55) {
      verdict = "EDGE";
      verdictText = "🟢 Genuine edge signal — hold stakes, keep logging";
    } else if (avg <= -1) {
      verdict = "NEGATIVE";
      verdictText =
        "🔴 Negative CLV — the market beats this model. Stop real stakes, paper only.";
    } else if (avg > -1 && avg < 1) {
      verdict = "NEUTRAL";
      verdictText = "🟡 No demonstrated edge yet — do not increase stakes";
    } else {
      verdict = "NEUTRAL";
      verdictText = "🟡 No demonstrated edge yet — do not increase stakes";
    }
  }

  return {
    betsWithClv: n,
    avgClv: avg,
    beatCount,
    beatPct,
    byGroup,
    verdict,
    verdictText,
  };
}

// ─────────────────────────────────────────────────────────────
// Calibration samples — settled straight-bet recs (real AND paper), excl
// PUSH/VOID.
//
// CRITICAL INVARIANT (EDGE-FIX tier 1): samples must carry the RAW
// (pre-calibration) model probability. λ is applied to raw probabilities in
// calculate.ts, so it must be FIT against raw probabilities too. Fitting on
// the calibrated value creates a feedback loop: each refit sees already-shrunk
// inputs, finds a λ closer to 1.0, and calibration silently disables itself.
// Old entries that predate model_probability_raw fall back to the calibrated
// value (imperfect but better than discarding the sample volume).
//
// Tier 3/4 (SGP/jackpot) recs are EXCLUDED: p_joint is a correlation-adjusted
// parlay product that is never calibrated — a different estimator class that
// would distort a λ meant for single-market probabilities.
// ─────────────────────────────────────────────────────────────
export function getCalibrationSamples(entries: LogEntry[]): CalibrationSample[] {
  const out: CalibrationSample[] = [];
  for (const r of allRecs(entries)) {
    // Shadow picks DO feed calibration volume (they are the model's own best
    // pick). Discretionary action bets do NOT — their odds are user-edited.
    if (r.action_bet === true) continue;
    if (r.outcome !== "WON" && r.outcome !== "LOST") continue; // excludes PENDING/PUSH/VOID
    const tierNum = Number(r.tier);
    if (tierNum === 3 || tierNum === 4) continue; // parlay probs never enter the fit
    const modelP = r.model_probability_raw ?? r.model_probability;
    if (typeof modelP !== "number") continue;
    if (typeof r.odds !== "number" || r.odds <= 0) continue;
    out.push({
      model_p: modelP,
      decimal_odds: r.odds,
      won: r.outcome === "WON",
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// Calibration table — buckets of CALIBRATED probability.
// ─────────────────────────────────────────────────────────────
export interface CalibrationBucketRow {
  label: string;
  predictedAvg: number | null; // avg model_probability (calibrated) in bucket
  realizedWinPct: number | null;
  count: number;
}

export function computeCalibrationTable(
  entries: LogEntry[],
): CalibrationBucketRow[] {
  const settled = allRecs(entries).filter(
    (r) =>
      r.action_bet !== true &&
      (r.outcome === "WON" || r.outcome === "LOST") &&
      typeof r.model_probability === "number",
  );
  const defs: Array<{ label: string; lo: number; hi: number }> = [
    { label: "<55%", lo: 0, hi: 0.55 },
    { label: "55–65%", lo: 0.55, hi: 0.65 },
    { label: "65–75%", lo: 0.65, hi: 0.75 },
    { label: "75%+", lo: 0.75, hi: 1.0001 },
  ];
  return defs.map((d) => {
    const g = settled.filter((r) => {
      const p = r.model_probability as number;
      return p >= d.lo && p < d.hi;
    });
    const predictedAvg =
      g.length > 0
        ? (g.reduce((s, r) => s + (r.model_probability as number), 0) /
            g.length) *
          100
        : null;
    const won = g.filter((r) => r.outcome === "WON").length;
    return {
      label: d.label,
      predictedAvg,
      realizedWinPct: g.length > 0 ? (won / g.length) * 100 : null,
      count: g.length,
    };
  });
}

// ─────────────────────────────────────────────────────────────
// Action-bet aggregate — discretionary "I placed this" bets, tracked to the
// dollar but kept OUT of the model's edge verdict. Shown in its own row.
// ─────────────────────────────────────────────────────────────
export interface ActionBetSummary {
  count: number; // total action recs (any outcome)
  settledCount: number; // WON + LOST
  pl: number; // realised profit/loss in dollars
  avgClv: number | null; // avg CLV over action recs that have a close captured
}

export function computeActionBetSummary(entries: LogEntry[]): ActionBetSummary {
  const recs = allRecs(entries).filter((r) => r.action_bet === true);
  let pl = 0;
  let settled = 0;
  for (const r of recs) {
    const stake = parseStake(r.stake);
    if (r.outcome === "WON") {
      const odds = typeof r.odds === "number" ? r.odds : 0;
      pl += stake * (odds - 1);
      settled += 1;
    } else if (r.outcome === "LOST") {
      pl -= stake;
      settled += 1;
    }
  }
  const clvRecs = recs.filter((r) => typeof r.clv_pct === "number");
  const avgClv =
    clvRecs.length > 0
      ? clvRecs.reduce((s, r) => s + (r.clv_pct as number), 0) / clvRecs.length
      : null;
  return { count: recs.length, settledCount: settled, pl, avgClv };
}

