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
  | { ok: true; data: ClaudeMessageResponse }
  | {
      ok: false;
      error: string;
      error_type?: "BILLING" | "TIMEOUT";
      status?: number;
    };

const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_MAX_TOKENS = 8000;

export async function callClaude(input: ClaudeCallInput): Promise<ClaudeCallResult> {
  const apiKey = process.env.ANTHROPIC_KEY;
  if (!apiKey) {
    return {
      ok: false,
      error: "Anthropic API key is not configured on the server.",
    };
  }

  const model =
    typeof input.model === "string" && input.model.trim() ? input.model : DEFAULT_MODEL;
  const maxTokens =
    typeof input.maxTokens === "number" && input.maxTokens > 0
      ? input.maxTokens
      : DEFAULT_MAX_TOKENS;

  // Anthropic sits behind Cloudflare; during peak load / degraded service the
  // response can exceed the normal 15-30s window. Cap each request at 3 minutes
  // and retry ONCE (after 10s) for transient timeouts / 5xx before surfacing a
  // clear error.
  const TIMEOUT_MS = 180_000;
  const TIMEOUT_MESSAGE =
    "Analysis timed out after 3 minutes. Anthropic API may be experiencing slow response times. Check status.anthropic.com and retry.";

  const requestBody = JSON.stringify({
    model,
    max_tokens: maxTokens,
    // Prompt caching (REST format): system is an array of content blocks and
    // cache_control is attached to the block, not the top level. The large,
    // static system prompt is cached so subsequent calls read it instead of
    // re-processing all its tokens.
    //
    // TTL is set to "1h" (extended cache) instead of the default 5 minutes.
    // Writing a 1h cache costs slightly more, but it keeps the system prompt
    // warm across same-day matches that kick off 1-3 hours apart — worth it
    // whenever 2+ matches are analysed within an hour in the same session.
    // Requires the "extended-cache-ttl-2025-04-11" beta header below.
    system: [
      {
        type: "text",
        text: input.systemPrompt,
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    ],
    messages: [{ role: "user", content: input.userMessage }],
  });

  const callAnthropic = async (): Promise<Response> => {
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
        body: requestBody,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };

  const isTransient = (status: number) =>
    status === 524 || status === 529 || status === 503 || status === 502;

  let response: Response;
  try {
    response = await callAnthropic();
    if (isTransient(response.status)) {
      console.warn(`callClaude: transient ${response.status} — retrying in 10s`);
      await new Promise((r) => setTimeout(r, 10_000));
      response = await callAnthropic();
    }
  } catch (err) {
    const isAbort = err instanceof Error && err.name === "AbortError";
    if (isAbort) {
      console.error("callClaude: Anthropic request timed out after 180s", err);
      return { ok: false, error_type: "TIMEOUT", error: TIMEOUT_MESSAGE };
    }
    try {
      await new Promise((r) => setTimeout(r, 10_000));
      response = await callAnthropic();
    } catch (retryErr) {
      console.error("callClaude: network error calling Anthropic", retryErr);
      return { ok: false, error: "Failed to reach the Anthropic API." };
    }
  }

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    console.error("callClaude: Anthropic API error", response.status, payload);
    const apiError = (payload as { error?: { type?: string; message?: string } } | null)?.error;
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
    if (response.status === 429) {
      return { ok: false, error: "Rate limit exceeded. Please try again shortly.", status: 429 };
    }
    if (isTransient(response.status)) {
      return {
        ok: false,
        error_type: "TIMEOUT",
        error: TIMEOUT_MESSAGE,
        status: response.status,
      };
    }
    if (response.status === 401) {
      return { ok: false, error: "Invalid Anthropic API key.", status: 401 };
    }
    return {
      ok: false,
      error: "The analysis service returned an error.",
      status: response.status,
    };
  }

  return { ok: true, data: (payload ?? {}) as ClaudeMessageResponse };
}
