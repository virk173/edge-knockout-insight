import { createServerFn } from "@tanstack/react-start";

/**
 * analyse-match
 *
 * Server-side proxy to the Anthropic Messages API. The frontend calls this
 * instead of talking to Anthropic directly, so the API key never reaches the
 * browser. The key is read from the server-only `ANTHROPIC_KEY` env var.
 *
 * Input:  { systemPrompt: string, matchData: string, model?: string, maxTokens?: number }
 * Output: the raw Claude JSON response (or a typed error shape on failure).
 */

interface AnalyseMatchInput {
  systemPrompt: string;
  userMessage: string;
  model?: string;
  maxTokens?: number;
}

const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_MAX_TOKENS = 16000;

function validateInput(input: unknown): AnalyseMatchInput {
  if (typeof input !== "object" || input === null) {
    throw new Error("Request body must be an object.");
  }
  const { systemPrompt, userMessage, matchData, model, maxTokens } =
    input as Record<string, unknown>;
  // Accept either `userMessage` (preferred) or legacy `matchData`.
  const message =
    typeof userMessage === "string" && userMessage.trim()
      ? userMessage
      : typeof matchData === "string"
        ? matchData
        : "";
  if (typeof systemPrompt !== "string" || systemPrompt.trim().length === 0) {
    throw new Error("`systemPrompt` is required and must be a non-empty string.");
  }
  if (message.trim().length === 0) {
    throw new Error("`userMessage` is required and must be a non-empty string.");
  }
  return {
    systemPrompt,
    userMessage: message,
    model: typeof model === "string" && model.trim() ? model : DEFAULT_MODEL,
    maxTokens: typeof maxTokens === "number" && maxTokens > 0 ? maxTokens : DEFAULT_MAX_TOKENS,
  };
}

export const analyseMatch = createServerFn({ method: "POST" })
  .inputValidator(validateInput)
  .handler(async ({ data }) => {
    const apiKey = process.env.ANTHROPIC_KEY;
    if (!apiKey) {
      return {
        ok: false as const,
        error: "Anthropic API key is not configured on the server.",
      };
    }

    // Anthropic sits behind Cloudflare; a very large prompt can make Claude take
    // >100s and the edge returns a 524 origin-timeout. We cap the wait at 90s
    // client-side and retry ONCE (after 10s) for transient timeouts / 5xx before
    // surfacing a clear error.
    const TIMEOUT_MS = 90_000;
    const requestBody = JSON.stringify({
      model: data.model,
      max_tokens: data.maxTokens,
      system: data.systemPrompt,
      messages: [{ role: "user", content: data.userMessage }],
    });

    const callAnthropic = async (): Promise<Response> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        return await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
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
      // Retry once on a transient server-side timeout / overload.
      if (isTransient(response.status)) {
        console.warn(`analyse-match: transient ${response.status} — retrying in 10s`);
        await new Promise((r) => setTimeout(r, 10_000));
        response = await callAnthropic();
      }
    } catch (err) {
      const isAbort = err instanceof Error && err.name === "AbortError";
      if (isAbort) {
        console.error("analyse-match: Anthropic request timed out after 90s", err);
        return {
          ok: false as const,
          error_type: "TIMEOUT" as const,
          error:
            "Analysis timed out — Claude took longer than 90 seconds to respond. This usually means the input data is too large. Retry or check the injection block sizes.",
        };
      }
      // Retry once on a network error before giving up.
      try {
        await new Promise((r) => setTimeout(r, 10_000));
        response = await callAnthropic();
      } catch (retryErr) {
        console.error("analyse-match: network error calling Anthropic", retryErr);
        return { ok: false as const, error: "Failed to reach the Anthropic API." };
      }
    }

    const payload = await response.json().catch(() => null);


    if (!response.ok) {
      console.error("analyse-match: Anthropic API error", response.status, payload);
      const apiError = (payload as { error?: { type?: string; message?: string } } | null)?.error;
      if (
        response.status === 400 &&
        apiError?.type === "invalid_request_error" &&
        typeof apiError?.message === "string" &&
        apiError.message.toLowerCase().includes("credit balance")
      ) {
        return {
          ok: false as const,
          error_type: "BILLING" as const,
          error:
            "Anthropic account credit balance is too low. Add credits at console.anthropic.com/settings/billing before running analysis.",
          status: 400,
        };
      }
      if (response.status === 429) {
        return { ok: false as const, error: "Rate limit exceeded. Please try again shortly.", status: 429 };
      }
      if (response.status === 401) {
        return { ok: false as const, error: "Invalid Anthropic API key.", status: 401 };
      }
      return {
        ok: false as const,
        error: "The analysis service returned an error.",
        status: response.status,
      };
    }

    // Return the raw Claude JSON response.
    return { ok: true as const, data: payload };
  });
