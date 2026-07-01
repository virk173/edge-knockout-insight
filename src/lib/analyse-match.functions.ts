import { createServerFn } from "@tanstack/react-start";
import type { ClaudeCallResult } from "./claude.server";

/**
 * analyse-match
 *
 * Synchronous server-side proxy to the Anthropic Messages API. This is the
 * ONLY analysis path: the formatted prompt is small (~13k input tokens after
 * per-block trimming in formatDataForClaude), so Claude responds in ~15-25s and
 * a direct synchronous call is simpler and more reliable than a background job
 * store (which was only warranted when the prompt approached the 200k limit).
 *
 * The actual Claude request lives in callClaude() (claude.server.ts) so its
 * config — model, max_tokens, prompt caching, timeout, retry — stays in one
 * place.
 */


interface AnalyseMatchInput {
  systemPrompt: string;
  userMessage: string;
  model?: string;
  maxTokens?: number;
}

function validateInput(input: unknown): AnalyseMatchInput {
  if (typeof input !== "object" || input === null) {
    throw new Error("Request body must be an object.");
  }
  const { systemPrompt, userMessage, matchData, model, maxTokens } =
    input as Record<string, unknown>;
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
    model: typeof model === "string" && model.trim() ? model : undefined,
    maxTokens: typeof maxTokens === "number" && maxTokens > 0 ? maxTokens : undefined,
  };
}

export const analyseMatch = createServerFn({ method: "POST" })
  .inputValidator(validateInput)
  .handler(async ({ data }): Promise<ClaudeCallResult> => {
    const { callClaude } = await import("./claude.server");
    return callClaude(data);
  });
