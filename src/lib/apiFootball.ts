import { incrementApiCallCount } from "./apiCounter";
import { apiFetch } from "./api-proxy.functions";

const AF_BASE = "https://v3.football.api-sports.io";

// Confirmed from the API-Football account/status response for this key:
// x-ratelimit-limit = 300 requests/minute, daily request limit = 7,500.
export const API_FOOTBALL_CONFIRMED_REQUESTS_PER_MINUTE = 300;

// Run at a deliberately conservative 50 rpm (20% of confirmed limit, capped),
// leaving large burst headroom instead of riding the 300 rpm ceiling.
export const API_FOOTBALL_SAFE_REQUESTS_PER_MINUTE = Math.min(
  Math.floor(API_FOOTBALL_CONFIRMED_REQUESTS_PER_MINUTE * 0.2),
  50,
);
export const API_FOOTBALL_DELAY_MS = Math.ceil(
  60000 / API_FOOTBALL_SAFE_REQUESTS_PER_MINUTE,
);
const API_FOOTBALL_RETRY_DELAY_MS = 6000;

interface AfResponse {
  errors?: unknown;
  response?: unknown;
}

interface ApiFetchResult {
  ok: boolean;
  status: number | string;
  statusText?: string;
  retryAfter?: string | null;
  json: unknown;
}

export interface ApiFootballDebugEntry {
  api: "API-Football";
  url: string;
  status: number | string;
  ok: boolean;
  json: unknown;
  error?: string;
}

interface ApiFootballOptions {
  callLabel?: string;
  onDebug?: (entry: ApiFootballDebugEntry) => void;
}

let queue: Promise<void> = Promise.resolve();
let nextAllowedAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normaliseErrors(errors: unknown): string | null {
  if (!errors) return null;
  if (Array.isArray(errors)) return errors.length ? errors.join(", ") : null;
  if (typeof errors === "object") {
    const values = Object.values(errors as Record<string, unknown>);
    return values.length ? values.map(String).join(", ") : null;
  }
  if (typeof errors === "string") return errors.trim() ? errors : null;
  return null;
}

async function pacedApiFootballGet(
  path: string,
  opts: ApiFootballOptions,
): Promise<unknown> {
  const url = `${AF_BASE}${path}`;
  const label = opts.callLabel ?? "?";

  const waitMs = Math.max(0, nextAllowedAt - Date.now());
  if (waitMs > 0) await sleep(waitMs);

  const attempt = async (attemptNo: 1 | 2): Promise<ApiFetchResult> => {
    console.log(
      `API-Football call ${label} ${attemptNo === 2 ? "retry " : ""}starting at ${new Date().toISOString()}`,
    );
    try {
      return (await apiFetch({
        data: { provider: "apifootball", url },
      })) as ApiFetchResult;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, status: "network error", statusText: msg, json: null };
    }
  };

  let result = await attempt(1);

  if (!result.ok && String(result.status) === "429") {
    const retryAfterMs = result.retryAfter
      ? Number.parseFloat(result.retryAfter) * 1000
      : 0;
    const delay = Math.max(
      API_FOOTBALL_RETRY_DELAY_MS,
      Number.isFinite(retryAfterMs) ? retryAfterMs : 0,
    );
    console.warn(
      `[API-Football] 429 rate limit on call ${label}. ` +
        `Retry-After: ${result.retryAfter ?? "(none)"} — waiting ${Math.round(delay / 1000)}s then retrying once.`,
      { status: result.status, body: result.json },
    );
    await sleep(delay);
    result = await attempt(2);
    if (!result.ok && String(result.status) === "429") {
      console.error(
        `[API-Football] 429 again on call ${label} after retry — marking this call EMPTY and continuing the pipeline.`,
        { status: result.status, body: result.json },
      );
      opts.onDebug?.({
        api: "API-Football",
        url,
        status: 429,
        ok: false,
        json: result.json ?? null,
        error: "Rate limited after retry; returned EMPTY.",
      });
      nextAllowedAt = Date.now() + API_FOOTBALL_DELAY_MS;
      return null;
    }
  }

  nextAllowedAt = Date.now() + API_FOOTBALL_DELAY_MS;

  if (!result || !result.ok) {
    const status = result?.status ?? "no response";
    opts.onDebug?.({
      api: "API-Football",
      url,
      status,
      ok: false,
      json: result?.json ?? null,
      error: result?.statusText,
    });
    throw new Error(`API-Football ${status} ${result?.statusText ?? ""}`.trim());
  }

  incrementApiCallCount();
  const json = (result.json ?? null) as AfResponse | null;
  opts.onDebug?.({
    api: "API-Football",
    url,
    status: result.status,
    ok: true,
    json,
  });
  const apiError = normaliseErrors(json?.errors);
  if (apiError) throw new Error(apiError);
  return json?.response ?? null;
}

/**
 * Shared API-Football GET helper. All callers are serialized through one queue,
 * so accidental Promise.all usage still cannot burst the API-Football key.
 */
export function apiFootballGet(
  path: string,
  opts: ApiFootballOptions = {},
): Promise<unknown> {
  const run = queue.then(() => pacedApiFootballGet(path, opts));
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}