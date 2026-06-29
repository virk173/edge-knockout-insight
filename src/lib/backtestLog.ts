/**
 * Backtesting log storage + analytics.
 *
 * Log entries are persisted in localStorage under "edge_wc2026_log".
 * Each analysis output that contains a `log_entry` is appended (never
 * overwritten). Outcomes are tracked per recommendation so that the summary
 * panel can compare win rates across ensemble-alignment buckets.
 */

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
}

export interface LogEntry {
  id: string;
  savedAt: string;
  match?: string;
  date?: string;
  round?: string;
  notes?: string;
  recommendations: LogRecommendation[];
}

/** Shape of the `log_entry` field produced by Claude (defensive/optional). */
export interface RawLogEntry {
  match?: string;
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
        ev: typeof r?.ev === "number" ? r.ev : undefined,
        confidence:
          typeof r?.confidence === "number" ? r.confidence : undefined,
        ensemble_alignment: r?.ensemble_alignment,
        sharp_signal: r?.sharp_signal,
        // Honour an explicit outcome from the raw entry; default PENDING.
        outcome:
          r?.outcome === "WON" || r?.outcome === "LOST" ? r.outcome : "PENDING",
      }))
    : [];

  const entry: LogEntry = {
    id: makeId(),
    savedAt: new Date().toISOString(),
    match: raw.match,
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
