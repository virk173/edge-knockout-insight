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

// A JSON value the server-fn serializer accepts (a bare `unknown` on the
// tool_use `input` breaks TanStack's serializability check).
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };


// Concrete, fully-serializable shape for the fields the client reads off the
// Anthropic response. (A bare `unknown`/`any` breaks TanStack's server-fn
// serializability check when this flows through the polling endpoint.)
export interface ClaudeMessageResponse {
  id?: string;
  model?: string;
  role?: string;
  stop_reason?: string;
  content?: Array<{
    type?: string;
    text?: string;
    // Present on `tool_use` blocks: the structured, already-parsed JSON object
    // the model produced for the forced submit_analysis tool call.
    id?: string;
    name?: string;
    input?: JsonValue;
  }>;
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

const DEFAULT_MODEL = "claude-sonnet-5";
const FALLBACK_MODEL = "claude-sonnet-4-6";
const DEFAULT_MAX_TOKENS = 6500;

// Native Structured Outputs (Anthropic tool use). We force this single tool so
// the model's response is a real JSON object on a `tool_use` block instead of a
// free-form text blob that needs fence-stripping / brace-slicing. The schema is
// intentionally SHALLOW (loose object/array/string leaves, additionalProperties
// everywhere): it removes markdown noise and guarantees the top-level shape
// without over-constraining the model — normalizeAnalysisResult() stays the
// authoritative safety net for missing/optional keys downstream.
const ANALYSIS_TOOL_NAME = "submit_analysis";

const loose = { type: "object", additionalProperties: true } as const;

const ANALYSIS_TOOL_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: true,
  properties: {
    match: { type: "string" },
    kickoff_UTC: { type: "string" },
    kickoff_local: { type: "string" },
    round: { type: "string" },
    classification: { type: "string" },
    data_quality: { type: "string" },
    ensemble_check: loose,
    confidence_scores: loose,
    tactical_analysis: loose,
    player_intelligence: loose,
    // model_probabilities and dimension_weights were REQUIRED by the system
    // prompt (Section 9, rule 34) but absent from this property list — with
    // structured outputs the model emits essentially only the enumerated
    // properties, so both fields silently vanished from every live run and
    // validateModelProbabilities / dimension-weights validation never ran.
    // Enumerating them here (and listing them in `required` below) is what
    // actually makes them appear; the prompt text alone could not.
    // Shape matches the app contract: home/draw/away PERCENTAGES summing to
    // 100 (validateModelProbabilities in calculate.ts), D1–D6 summing to 100.
    model_probabilities: {
      type: "object",
      additionalProperties: true,
      properties: {
        home: { type: "number" },
        draw: { type: "number" },
        away: { type: "number" },
      },
      required: ["home", "draw", "away"],
    },
    probability_derivation: {},
    dimension_weights: {
      type: "object",
      additionalProperties: true,
      properties: {
        D1: { type: "number" },
        D2: { type: "number" },
        D3: { type: "number" },
        D4: { type: "number" },
        D5: { type: "number" },
        D6: { type: "number" },
        adjustment_reason: {},
      },
      required: ["D1", "D2", "D3", "D4", "D5", "D6"],
    },
    bet_1: loose,
    bet_2: loose,
    bet_3: loose,
    bet_4: loose,
    markets_evaluated: { type: "array", items: { type: "string" } },
    markets_rejected: { type: "array", items: loose },
    key_risk_flag: { type: "string" },
    analyst_note: { type: "string" },
    log_entry: loose,
  },
  required: ["model_probabilities", "dimension_weights"],
} as const;

// Per-attempt timeout. Measured directly (live diagnostic call): a real
// request generated 6,057 output tokens in 54.1s (~112 tok/s), extrapolating
// to ~71.5s for a full 8,000-token response — that only left ~19s of margin
// under the old 90s timeout, too tight for normal variance (richer matches,
// Anthropic-side load). 150s gives ~79s of margin above the measured worst
// case. DEFAULT_MAX_TOKENS was also cut to 6500 (was the real timeout risk,
// not a real content requirement — see that constant's own comment).
//
// NOTE: worst-case retry chain is now 150+10+150+10+150 = 470s. Verify hosting
// platform function duration limit exceeds this before deploying. On Vercel
// hobby plan the limit is 60s — this app requires a pro plan or equivalent
// with at least 300s function timeout.
const TIMEOUT_MS = 150_000;
const WAIT_BETWEEN_MS = 10_000;
const TIMEOUT_MESSAGE =
  "Analysis timed out. Anthropic did not respond within the retry budget (2x primary + 1x fallback @ 150s each). Please retry.";

// Retry plan: primary model twice, then the fallback model once.
// Attempt 1: claude-sonnet-5     (150s) -> wait 10s
// Attempt 2: claude-sonnet-5     (150s) -> wait 10s
// Attempt 3: claude-sonnet-4-6   (150s) [fallback]
// Total maximum 150+10+150+10+150 = 470s before a clean "failed".
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
      // Force the model to answer by calling submit_analysis, so the response
      // arrives as structured JSON on a tool_use block. cache_control keeps the
      // (static) tool definition warm alongside the system prompt.
      tools: [
        {
          name: ANALYSIS_TOOL_NAME,
          description:
            "Submit the completed match analysis as a single structured JSON object. Populate every field you would otherwise have returned as raw JSON text — do not omit sections that you have data for.",
          input_schema: ANALYSIS_TOOL_INPUT_SCHEMA,
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
      ],
      tool_choice: { type: "tool", name: ANALYSIS_TOOL_NAME },
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
      const data = (payload ?? {}) as ClaudeMessageResponse;

      // A forced tool_use truncated by max_tokens leaves the JSON incomplete and
      // unusable. Treat it exactly like a transient failure: retry / fall back
      // rather than handing a half-built payload to the parser.
      if (data.stop_reason === "max_tokens") {
        console.error(
          `callClaude: attempt ${i + 1}/${attempts.length} (${model}) hit max_tokens — tool payload truncated`,
        );
        lastError =
          "Analysis exceeded the output token budget before completing. Please retry.";
        if (!isFallback) primaryFailures += 1;
        if (i < attempts.length - 1) {
          await new Promise((r) => setTimeout(r, WAIT_BETWEEN_MS));
          continue;
        }
        break;
      }

      const result: ClaudeCallResult = {
        ok: true,
        data,
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
