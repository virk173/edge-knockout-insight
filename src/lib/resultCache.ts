// Persistent cache for completed match analyses. A finished analysis normally
// lives only in React state (matchStates) and is wiped on reload, which makes
// EV auditing impossible and strips EV context from the backtesting log. This
// module persists the full enriched calculateResults() output — plus the raw
// Claude JSON, the SGP intermediate chain, token usage and response time — to
// localStorage under a date-scoped key so it can be reloaded and audited.
//
// Cache key: "edge_result_{match_id}_{YYYY-MM-DD}"
// Expiry:    24 hours (yesterday's matches aren't useful for today's decisions).

import type { AnalysisResult } from "./analysisResult";

export const RESULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h

// The SGP intermediate chain, captured post-fix (no hold_rate in the EV math).
export interface SgpChain {
  p_independent: number | null;
  correlation_factor: number | null;
  p_joint: number | null;
  hold_rate: number | null; // diagnostic only
  stake_sgp: number | null;
  parlay_ev: number | null;
}

export interface PersistedResult {
  matchId: number;
  match: string;
  result: AnalysisResult;
  rawClaudeJson: string;
  sgpChain: SgpChain;
  tokenUsage: { input: number; output: number } | null;
  responseTimeMs: number | null;
  savedAt: number; // epoch ms
}

function todayStr(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function resultCacheKey(matchId: number | string): string {
  return `edge_result_${matchId}_${todayStr()}`;
}

function toNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number.parseFloat(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * Pull the SGP intermediate chain out of an enriched result. Reads the correct
 * post-fix inputs (p_joint / stake_sgp from parlay_ev_inputs) and the diagnostic
 * probability_derivation fields (p_independent, correlation_factor, hold_rate).
 */
export function extractSgpChain(result: AnalysisResult | null | undefined): SgpChain {
  const t2 = (result?.bet_3 ?? {}) as Record<string, unknown>;
  const inputs = (t2.parlay_ev_inputs ?? {}) as Record<string, unknown>;
  const deriv = (t2.probability_derivation ?? {}) as Record<string, unknown>;
  const sgpVal = (t2.sgp_validation ?? {}) as Record<string, unknown>;

  return {
    p_independent: toNum(deriv.p_independent),
    correlation_factor: toNum(deriv.correlation_factor),
    p_joint: toNum(inputs.p_joint) ?? toNum(deriv.p_joint),
    hold_rate: toNum(inputs.hold_rate) ?? toNum(deriv.hold_rate) ?? toNum(sgpVal.hold_rate),
    stake_sgp: toNum(inputs.stake_sgp) ?? toNum(sgpVal.stake_sgp_price),
    parlay_ev: toNum(t2.parlay_ev),
  };
}

export function writeResultCache(entry: Omit<PersistedResult, "savedAt"> & { savedAt?: number }): PersistedResult {
  const payload: PersistedResult = { ...entry, savedAt: entry.savedAt ?? Date.now() };
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.setItem(resultCacheKey(entry.matchId), JSON.stringify(payload));
    } catch {
      // ignore quota / serialization errors
    }
  }
  return payload;
}

export function readResultCache(matchId: number | string): PersistedResult | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(resultCacheKey(matchId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedResult;
    if (!parsed || typeof parsed.savedAt !== "number") return null;
    if (Date.now() - parsed.savedAt > RESULT_TTL_MS) {
      localStorage.removeItem(resultCacheKey(matchId));
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

// "✓ Analysed X min ago" style relative label.
export function formatResultAgo(savedAt: number, now: number = Date.now()): string {
  const mins = Math.floor(Math.max(0, now - savedAt) / 60000);
  if (mins < 1) return "just now";
  if (mins === 1) return "1 min ago";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  return hrs === 1 ? "1 hr ago" : `${hrs} hr ago`;
}
