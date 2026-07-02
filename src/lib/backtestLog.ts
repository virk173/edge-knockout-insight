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

export const LOG_STORAGE_KEY = "edge_wc2026_log";

export type Outcome = "PENDING" | "WON" | "LOST";

export interface LogRecommendation {
  tier?: number | string;
  market?: string;
  selection?: string;
  odds?: number;
  stake?: string;
  model_probability?: number;
  ev?: number;
  confidence?: number;
  ensemble_alignment?: string;
  sharp_signal?: string;
  outcome: Outcome;
  // Strict-signal regime: paper bets never touch the bankroll on settlement.
  paper?: boolean;
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

/** EV realised: WON -> odds - 1, LOST -> -1, PENDING -> null. */
export function computeEvRealised(rec: LogRecommendation): number | null {
  if (rec.outcome === "WON") {
    const odds = typeof rec.odds === "number" ? rec.odds : 0;
    return odds - 1;
  }
  if (rec.outcome === "LOST") return -1;
  return null;
}

/** Cycle a badge outcome PENDING -> WON -> LOST -> PENDING. */
export function cycleOutcome(outcome: Outcome): Outcome {
  if (outcome === "PENDING") return "WON";
  if (outcome === "WON") return "LOST";
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
        // ev/confidence: only a real computed number is ever stored; the literal
        // "PENDING_APP_COMPUTE" string is a non-number and becomes undefined.
        ev: typeof r?.ev === "number" ? r.ev : undefined,
        confidence:
          typeof r?.confidence === "number" ? r.confidence : undefined,
        ensemble_alignment: sanitizeString(r?.ensemble_alignment),
        sharp_signal: sanitizeString(r?.sharp_signal),
        paper: r?.paper === true,
        closing_odds:
          typeof r?.closing_odds === "number" ? r.closing_odds : undefined,
        closing_source: sanitizeString(r?.closing_source),
        clv_pct: typeof r?.clv_pct === "number" ? r.clv_pct : undefined,
        // Honour an explicit outcome from the raw entry; default PENDING.
        outcome:
          r?.outcome === "WON" || r?.outcome === "LOST" ? r.outcome : "PENDING",
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

  // Merge into any existing MANUAL capture so multiple manual prices accumulate.
  const existing = readClosingCapture(entry.matchId);
  const prices =
    existing && existing.source === "MANUAL" && existing.prices
      ? { ...existing.prices }
      : {};
  const marketKey = rec.market ?? "Manual";
  const list = Array.isArray(prices[marketKey]) ? [...prices[marketKey]] : [];
  const selKey = rec.selection ?? "";
  const idx = list.findIndex(
    (o) => (o.selection ?? "").toLowerCase() === selKey.toLowerCase(),
  );
  if (idx >= 0) list[idx] = { selection: selKey, odds };
  else list.push({ selection: selKey, odds });
  prices[marketKey] = list;

  writeClosingCapture({
    matchId: entry.matchId,
    capturedAt: Date.now(),
    minutesBeforeKickoff: 0,
    source: "MANUAL",
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
  const recs = entries.flatMap((e) => e.recommendations);

  let totalStaked = 0;
  let totalReturned = 0;
  let wonCount = 0;
  let lostCount = 0;
  let pendingCount = 0;
  let evSum = 0;
  let evCount = 0;
  let confSum = 0;
  let confCount = 0;

  for (const r of recs) {
    const stake = parseStake(r.stake);
    totalStaked += stake;
    if (r.outcome === "WON") {
      wonCount += 1;
      const odds = typeof r.odds === "number" ? r.odds : 0;
      totalReturned += stake * odds;
    } else if (r.outcome === "LOST") {
      lostCount += 1;
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
    roi: totalStaked > 0 ? ((totalReturned - totalStaked) / totalStaked) * 100 : null,
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
  const recs = allRecs(entries).filter((r) => typeof r.clv_pct === "number");
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
// Calibration samples — ALL settled recs (real AND paper), excl PUSH/VOID.
// ─────────────────────────────────────────────────────────────
export function getCalibrationSamples(entries: LogEntry[]): CalibrationSample[] {
  const out: CalibrationSample[] = [];
  for (const r of allRecs(entries)) {
    if (r.outcome !== "WON" && r.outcome !== "LOST") continue; // excludes PENDING/PUSH/VOID
    if (typeof r.model_probability !== "number") continue;
    if (typeof r.odds !== "number" || r.odds <= 0) continue;
    out.push({
      model_p: r.model_probability,
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
