/**
 * calibration.ts — probability calibration loop.
 *
 * If Claude's 60% calls only win 52% of the time, its probabilities are
 * overconfident and every EV is inflated. We shrink model probabilities toward
 * the market price by a factor λ that is FIT from our own settled results, then
 * compute EV/Kelly from the calibrated probability.
 *
 *   calibratedP = marketP + λ * (modelP - marketP)
 *
 * λ = 1  → trust the model fully (no shrink)
 * λ = 0  → trust the market fully (full shrink to 1/odds)
 *
 * λ is fit by grid-search minimising Brier score over settled bets, but only
 * once we have MIN_N_TO_FIT samples. Below that it stays at DEFAULT_LAMBDA.
 * All storage access is SSR-guarded.
 */

const CALIBRATION_KEY = "edge_calibration";

export const DEFAULT_LAMBDA = 0.7; // prior: LLM probabilities modestly overconfident
export const MIN_N_TO_FIT = 20;

export interface CalibrationState {
  lambda: number;
  n: number;
  brier: number | null;
  updatedAt: number;
}

export interface CalibrationSample {
  model_p: number;
  decimal_odds: number;
  won: boolean;
}

function hasWindow(): boolean {
  return typeof window !== "undefined";
}

export function getCalibration(): CalibrationState {
  const fallback: CalibrationState = {
    lambda: DEFAULT_LAMBDA,
    n: 0,
    brier: null,
    updatedAt: 0,
  };
  if (!hasWindow()) return fallback;
  const raw = window.localStorage.getItem(CALIBRATION_KEY);
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as Partial<CalibrationState>;
    return {
      lambda:
        typeof parsed.lambda === "number" && Number.isFinite(parsed.lambda)
          ? Math.min(1, Math.max(0, parsed.lambda))
          : DEFAULT_LAMBDA,
      n: typeof parsed.n === "number" ? parsed.n : 0,
      brier:
        typeof parsed.brier === "number" && Number.isFinite(parsed.brier)
          ? parsed.brier
          : null,
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
    };
  } catch {
    return fallback;
  }
}

export function getLambda(): number {
  return getCalibration().lambda;
}

function writeCalibration(state: CalibrationState): void {
  if (!hasWindow()) return;
  window.localStorage.setItem(CALIBRATION_KEY, JSON.stringify(state));
}

/**
 * Shrink a model probability toward the market-implied probability by λ.
 *   marketP = 1 / decimalOdds  (includes vig → a conservative anchor, accepted)
 *   return marketP + λ * (modelP - marketP)
 *
 * λ is clamped to [0,1] (the fitted grid's range — anything outside is
 * corruption, and λ > 1 would EXPAND model overconfidence instead of
 * shrinking it) and the output is clamped to a valid probability. Codex
 * adversarial review 2026-07-05: an unclamped stale λ could turn a valid
 * probability into p > 1 → inflated EV → capped real stake.
 */
export function calibrateProbability(
  modelP: number,
  decimalOdds: number,
  lambda: number,
): number {
  if (!Number.isFinite(decimalOdds) || decimalOdds <= 0) return modelP;
  const lam = Number.isFinite(lambda) ? Math.min(1, Math.max(0, lambda)) : DEFAULT_LAMBDA;
  const marketP = 1 / decimalOdds;
  const calibrated = marketP + lam * (modelP - marketP);
  return Math.min(0.999, Math.max(0.001, calibrated));
}

/** Brier score = mean((calibratedP - won01)^2) over samples for a given λ. */
function brierForLambda(samples: CalibrationSample[], lambda: number): number {
  let sum = 0;
  for (const s of samples) {
    const p = calibrateProbability(s.model_p, s.decimal_odds, lambda);
    const won01 = s.won ? 1 : 0;
    sum += (p - won01) ** 2;
  }
  return samples.length ? sum / samples.length : Number.POSITIVE_INFINITY;
}

/**
 * Grid-search λ from 0.1 to 1.0 (step 0.05) minimising Brier score.
 * Persists {lambda, n, brier, updatedAt} when n ≥ MIN_N_TO_FIT; below that λ
 * stays at DEFAULT_LAMBDA (still persisted with the running n).
 *
 * Samples come from ALL settled recommendations (real AND paper).
 * PUSH/VOID must be excluded by the caller before passing samples in.
 */
export function fitLambda(samples: CalibrationSample[]): number {
  const clean = samples.filter(
    (s) =>
      Number.isFinite(s.model_p) &&
      Number.isFinite(s.decimal_odds) &&
      s.decimal_odds > 0,
  );

  if (clean.length < MIN_N_TO_FIT) {
    const state: CalibrationState = {
      lambda: DEFAULT_LAMBDA,
      n: clean.length,
      brier: clean.length ? brierForLambda(clean, DEFAULT_LAMBDA) : null,
      updatedAt: Date.now(),
    };
    writeCalibration(state);
    return DEFAULT_LAMBDA;
  }

  let bestLambda = DEFAULT_LAMBDA;
  let bestBrier = Number.POSITIVE_INFINITY;
  for (let lambda = 0.1; lambda <= 1.0001; lambda += 0.05) {
    const l = Math.round(lambda * 100) / 100;
    const b = brierForLambda(clean, l);
    if (b < bestBrier) {
      bestBrier = b;
      bestLambda = l;
    }
  }

  const state: CalibrationState = {
    lambda: bestLambda,
    n: clean.length,
    brier: Math.round(bestBrier * 1e6) / 1e6,
    updatedAt: Date.now(),
  };
  writeCalibration(state);
  return bestLambda;
}
