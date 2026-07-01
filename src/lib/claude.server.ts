// Server-only Anthropic Messages API caller.
//
// This is the SINGLE place the Claude call is configured (model, max_tokens,
// prompt caching, timeout, retry, error mapping). Both the legacy synchronous
// `analyseMatch` server function AND the new background-job runner call this so
// the request is byte-for-byte identical — the only difference is *where* it is
// awaited (inside a request vs. inside a fire-and-forget job).
//
// `.server.ts` files are stripped from the client bundle, so the ANTHROPIC_KEY
// read here never reaches the browser.

export interface ClaudeCallInput {
  systemPrompt: string;
  userMessage: string;
  model?: string;
  maxTokens?: number;
}

// Concrete, fully-serializable shape for the fields the client reads off the
// Anthropic response. (A bare `unknown`/`any` breaks TanStack's server-fn
// serializability check when this flows through the polling endpoint.)
export interface ClaudeMessageResponse {
  id?: string;
  model?: string;
  role?: string;
  stop_reason?: string;
  content?: Array<{ type?: string; text?: string }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

export type ClaudeCallResult =
  | {
      ok: true;
      data: ClaudeMessageResponse;
      // Set when attempts on the primary model timed out / failed and the
      // fallback model produced the result. The client surfaces an amber banner.
      used_fallback_model?: boolean;
      fallback_reason?: string;
    }
  | {
      ok: false;
      error: string;
      error_type?: "BILLING" | "TIMEOUT";
      status?: number;
    };

const DEFAULT_MODEL = "claude-sonnet-4-6";
const FALLBACK_MODEL = "claude-sonnet-4-5";
const DEFAULT_MAX_TOKENS = 8000;

// Per-attempt timeout. Generating up to 8k OUTPUT tokens is the bottleneck
// (~60-90s), independent of Anthropic load, so 60s was too tight and every
// attempt aborted mid-generation. 90s lets a normal response finish while still
// failing cleanly far inside the 10-min job TTL (worst case 90+10+90+10+90 =
// ~290s) — well before any worker-isolate restart can strand the in-memory job
// (the real cause of the old "Job expired" reports on 3-minute calls).
const TIMEOUT_MS = 90_000;
const WAIT_BETWEEN_MS = 10_000;
const TIMEOUT_MESSAGE =
  "Analysis timed out. Anthropic did not respond within the retry budget (2x primary + 1x fallback @ 90s each). Please retry.";

// Retry plan: primary model twice, then the fallback model once.
// Attempt 1: claude-sonnet-4-6  (60s)  -> wait 10s
// Attempt 2: claude-sonnet-4-6  (60s)  -> wait 10s
// Attempt 3: claude-sonnet-4-5  (60s)  [fallback]
// Total maximum ~210s before a clean "failed".
interface Attempt {
  model: string;
  isFallback: boolean;
}

export async function callClaude(input: ClaudeCallInput): Promise<ClaudeCallResult> {
  const apiKey = process.env.ANTHROPIC_KEY;
  if (!apiKey) {
    return {
      ok: false,
      error: "Anthropic API key is not configured on the server.",
    };
  }

  const primaryModel =
    typeof input.model === "string" && input.model.trim() ? input.model : DEFAULT_MODEL;
  const maxTokens =
    typeof input.maxTokens === "number" && input.maxTokens > 0
      ? input.maxTokens
      : DEFAULT_MAX_TOKENS;

  const buildBody = (model: string): string =>
    JSON.stringify({
      model,
      max_tokens: maxTokens,
      // Prompt caching (REST format): system is an array of content blocks and
      // cache_control is attached to the block, not the top level. TTL "1h"
      // keeps the large static system prompt warm across same-day matches.
      system: [
        {
          type: "text",
          text: input.systemPrompt,
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
      ],
      messages: [{ role: "user", content: input.userMessage }],
    });

  const callAnthropic = async (model: string): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      return await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "prompt-caching-2024-07-31,extended-cache-ttl-2025-04-11",
        },
        body: buildBody(model),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };

  const isTransient = (status: number) =>
    status === 524 || status === 529 || status === 503 || status === 502 || status === 429;

  const attempts: Attempt[] = [
    { model: primaryModel, isFallback: false },
    { model: primaryModel, isFallback: false },
    { model: FALLBACK_MODEL, isFallback: true },
  ];

  let lastError = "The analysis service did not return a response.";
  let lastErrorType: "TIMEOUT" | undefined;
  let lastStatus: number | undefined;
  let primaryTimeouts = 0;
  let primaryFailures = 0;

  for (let i = 0; i < attempts.length; i++) {
    const { model, isFallback } = attempts[i];

    let response: Response | null = null;
    try {
      response = await callAnthropic(model);
    } catch (err) {
      const isAbort = err instanceof Error && err.name === "AbortError";
      if (isAbort) {
        console.error(
          `callClaude: attempt ${i + 1}/${attempts.length} (${model}) timed out after ${TIMEOUT_MS}ms`,
        );
        lastError = TIMEOUT_MESSAGE;
        lastErrorType = "TIMEOUT";
        if (!isFallback) primaryTimeouts += 1;
      } else {
        console.error(
          `callClaude: attempt ${i + 1}/${attempts.length} (${model}) network error`,
          err,
        );
        lastError = "Failed to reach the Anthropic API.";
        if (!isFallback) primaryFailures += 1;
      }
      if (i < attempts.length - 1) {
        await new Promise((r) => setTimeout(r, WAIT_BETWEEN_MS));
        continue;
      }
      break;
    }

    const payload = await response.json().catch(() => null);

    if (response.ok) {
      const result: ClaudeCallResult = {
        ok: true,
        data: (payload ?? {}) as ClaudeMessageResponse,
      };
      if (isFallback) {
        result.used_fallback_model = true;
        const reasons: string[] = [];
        if (primaryTimeouts > 0)
          reasons.push(`${primaryModel} timed out ${primaryTimeouts}x`);
        if (primaryFailures > 0)
          reasons.push(`${primaryModel} errored ${primaryFailures}x`);
        result.fallback_reason =
          reasons.length > 0 ? reasons.join(" and ") : `${primaryModel} did not respond`;
        console.warn(
          `callClaude: succeeded on fallback ${FALLBACK_MODEL} — ${result.fallback_reason}`,
        );
      }
      return result;
    }

    // Non-OK response — decide whether it is worth retrying.
    console.error(
      `callClaude: attempt ${i + 1}/${attempts.length} (${model}) API error`,
      response.status,
      payload,
    );
    const apiError = (payload as { error?: { type?: string; message?: string } } | null)?.error;

    // Billing / auth failures will NOT be fixed by retrying — fail fast.
    if (
      response.status === 400 &&
      apiError?.type === "invalid_request_error" &&
      typeof apiError?.message === "string" &&
      apiError.message.toLowerCase().includes("credit balance")
    ) {
      return {
        ok: false,
        error_type: "BILLING",
        error:
          "Anthropic account credit balance is too low. Add credits at console.anthropic.com/settings/billing before running analysis.",
        status: 400,
      };
    }
    if (response.status === 401) {
      return { ok: false, error: "Invalid Anthropic API key.", status: 401 };
    }

    // Transient (5xx / 429): remember and retry the next attempt.
    if (isTransient(response.status)) {
      lastError =
        response.status === 429
          ? "Rate limit exceeded. Please try again shortly."
          : TIMEOUT_MESSAGE;
      lastErrorType = response.status === 429 ? undefined : "TIMEOUT";
      lastStatus = response.status;
      if (!isFallback) primaryFailures += 1;
      if (i < attempts.length - 1) {
        await new Promise((r) => setTimeout(r, WAIT_BETWEEN_MS));
        continue;
      }
      break;
    }

    // Any other non-OK status is not retryable.
    return {
      ok: false,
      error: "The analysis service returned an error.",
      status: response.status,
    };
  }

  // All attempts exhausted — ALWAYS a clean terminal result, never a silent hang.
  return { ok: false, error: lastError, error_type: lastErrorType, status: lastStatus };
}
