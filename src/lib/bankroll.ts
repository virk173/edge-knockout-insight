/**
 * bankroll.ts — one persistent, bankroll-based Kelly engine.
 *
 * There is a single running bankroll. Every straight bet is sized by
 * quarter-Kelly against the CURRENT bankroll (see calculate.ts). Settled bets
 * mutate the bankroll and append to a ledger so stakes shrink in drawdowns and
 * grow when winning. All localStorage access is SSR-guarded.
 */

export const BANKROLL_DEFAULTS = {
  STARTING_BANKROLL: 500,
  KELLY_FRACTION: 0.25,
  MAX_BET_PCT: 0.025, // 2.5% cap per straight bet
  MAX_MATCH_EXPOSURE_PCT: 0.05, // 5% cap per match
  SGP_STAKE_PCT: 0.01, // 1% flat for Bet 3
  JACKPOT_STAKE_PCT: 0.005, // 0.5% flat for Bet 4
  MIN_ACTIONABLE_STAKE: 2, // below this → skip, not floor
} as const;

const BANKROLL_KEY = "edge_bankroll_current";
const LEDGER_KEY = "edge_bankroll_ledger";

export type BankrollOutcome = "WON" | "LOST" | "PUSH" | "VOID";

export interface LedgerEntry {
  id: string; // uuid
  at: number; // epoch ms
  match: string;
  bet_label: string; // "BET 1 — Asian Handicap Spain -1"
  stake: number;
  odds: number;
  outcome: BankrollOutcome;
  profit: number; // WON: stake*(odds-1); LOST: -stake; PUSH/VOID: 0
  bankroll_after: number;
}

function hasWindow(): boolean {
  return typeof window !== "undefined";
}

function makeId(): string {
  try {
    if (hasWindow() && typeof window.crypto?.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
  } catch {
    // fall through to fallback id
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Read the current bankroll, seeding STARTING_BANKROLL when absent. */
export function getBankroll(): number {
  if (!hasWindow()) return BANKROLL_DEFAULTS.STARTING_BANKROLL;
  const raw = window.localStorage.getItem(BANKROLL_KEY);
  if (raw === null) {
    setBankroll(BANKROLL_DEFAULTS.STARTING_BANKROLL);
    return BANKROLL_DEFAULTS.STARTING_BANKROLL;
  }
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : BANKROLL_DEFAULTS.STARTING_BANKROLL;
}

/** Manually set the bankroll (deposits / withdrawals / corrections). */
export function setBankroll(v: number): void {
  if (!hasWindow()) return;
  const n = Number.isFinite(v) ? v : BANKROLL_DEFAULTS.STARTING_BANKROLL;
  window.localStorage.setItem(BANKROLL_KEY, String(n));
}

function safeParseLedger(raw: string | null): LedgerEntry[] {
  if (!raw) return [];
  try {
    const data = JSON.parse(raw);
    return Array.isArray(data) ? (data as LedgerEntry[]) : [];
  } catch {
    return [];
  }
}

export function getLedger(): LedgerEntry[] {
  if (!hasWindow()) return [];
  return safeParseLedger(window.localStorage.getItem(LEDGER_KEY));
}

function writeLedger(entries: LedgerEntry[]): void {
  if (!hasWindow()) return;
  window.localStorage.setItem(LEDGER_KEY, JSON.stringify(entries));
}

/** Profit from a settled bet outcome. */
export function computeProfit(
  outcome: BankrollOutcome,
  stake: number,
  odds: number,
): number {
  if (outcome === "WON") return stake * (odds - 1);
  if (outcome === "LOST") return -stake;
  return 0; // PUSH / VOID
}

/**
 * Settle a bet: compute profit from the outcome, apply it to the bankroll,
 * append the entry to the ledger, and return the completed entry.
 */
export function settleBet(
  entry: Omit<LedgerEntry, "id" | "at" | "profit" | "bankroll_after">,
): LedgerEntry {
  const profit = computeProfit(entry.outcome, entry.stake, entry.odds);
  const bankrollAfter = getBankroll() + profit;
  const full: LedgerEntry = {
    ...entry,
    id: makeId(),
    at: Date.now(),
    profit,
    bankroll_after: bankrollAfter,
  };
  setBankroll(bankrollAfter);
  writeLedger([...getLedger(), full]);
  return full;
}

/** Pop the last ledger entry and reverse its profit (misclick correction). */
export function undoLastSettlement(): LedgerEntry | null {
  const ledger = getLedger();
  if (ledger.length === 0) return null;
  const last = ledger[ledger.length - 1];
  setBankroll(getBankroll() - last.profit);
  writeLedger(ledger.slice(0, -1));
  return last;
}

/**
 * Reverse and remove a SPECIFIC ledger entry by id (used when an action bet's
 * outcome is changed after settlement). Reverses its profit against the current
 * bankroll and drops it from the ledger. No-op when the id is not found.
 */
export function removeLedgerEntry(id: string): LedgerEntry | null {
  const ledger = getLedger();
  const idx = ledger.findIndex((e) => e.id === id);
  if (idx === -1) return null;
  const entry = ledger[idx];
  setBankroll(getBankroll() - entry.profit);
  writeLedger([...ledger.slice(0, idx), ...ledger.slice(idx + 1)]);
  return entry;
}
