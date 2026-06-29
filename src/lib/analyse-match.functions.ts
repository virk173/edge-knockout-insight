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
const DEFAULT_MAX_TOKENS = 4000;

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

    let response: Response;
    try {
      response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: data.model,
          max_tokens: data.maxTokens,
          system: data.systemPrompt,
          messages: [{ role: "user", content: data.matchData }],
        }),
      });
    } catch (err) {
      console.error("analyse-match: network error calling Anthropic", err);
      return { ok: false as const, error: "Failed to reach the Anthropic API." };
    }

    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      console.error("analyse-match: Anthropic API error", response.status, payload);
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
