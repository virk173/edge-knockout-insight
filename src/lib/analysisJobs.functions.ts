import { createServerFn } from "@tanstack/react-start";
import type { ClaudeCallResult } from "./claude.server";

/**
 * Background-job API for the Claude analysis, so a running analysis survives the
 * browser being backgrounded / the tab losing focus.
 *
 * - startAnalysis: accepts the same payload the synchronous call used, kicks off
 *   the Claude call server-side, and returns a job id immediately.
 * - getAnalysisResult: polled by the client; returns pending / complete / failed.
 *
 * The .server-only helpers are imported INSIDE the handlers. Server-function
 * modules ship to the client bundle (only handler bodies are stripped), and
 * .server files are blocked from the client bundle — a module-scope import would
 * break the build, so we dynamic-import at call time (module state persists in
 * the worker isolate regardless).
 */

interface StartInput {
  systemPrompt: string;
  userMessage: string;
  model?: string;
  maxTokens?: number;
}

function validateStart(input: unknown): StartInput {
  if (typeof input !== "object" || input === null) {
    throw new Error("Request body must be an object.");
  }
  const { systemPrompt, userMessage, model, maxTokens } = input as Record<string, unknown>;
  if (typeof systemPrompt !== "string" || systemPrompt.trim().length === 0) {
    throw new Error("`systemPrompt` is required and must be a non-empty string.");
  }
  if (typeof userMessage !== "string" || userMessage.trim().length === 0) {
    throw new Error("`userMessage` is required and must be a non-empty string.");
  }
  return {
    systemPrompt,
    userMessage,
    model: typeof model === "string" && model.trim() ? model : undefined,
    maxTokens: typeof maxTokens === "number" && maxTokens > 0 ? maxTokens : undefined,
  };
}

export const startAnalysis = createServerFn({ method: "POST" })
  .inputValidator(validateStart)
  .handler(async ({ data }): Promise<{ jobId: string }> => {
    const { createJob, runJob } = await import("./analysisJobs.server");
    const jobId = createJob();
    // Fire-and-forget: do NOT await. The response returns immediately with the
    // job id; the Claude call continues in the background and its result is
    // stored on the job when it completes.
    runJob(jobId, data);
    return { jobId };
  });

export type AnalysisPollResult =
  | { status: "pending" }
  | { status: "complete"; result: ClaudeCallResult }
  | { status: "failed"; error: string };

function validatePoll(input: unknown): { jobId: string } {
  if (typeof input !== "object" || input === null) {
    throw new Error("Request body must be an object.");
  }
  const { jobId } = input as Record<string, unknown>;
  if (typeof jobId !== "string" || jobId.trim().length === 0) {
    throw new Error("`jobId` is required.");
  }
  return { jobId };
}

export const getAnalysisResult = createServerFn({ method: "POST" })
  .inputValidator(validatePoll)
  .handler(async ({ data }): Promise<AnalysisPollResult> => {
    const { getJob } = await import("./analysisJobs.server");
    const job = getJob(data.jobId);
    if (!job) {
      // Never existed, expired after 10 min, or the worker restarted and lost
      // its in-memory job.
      return {
        status: "failed",
        error: "Job expired — please re-run analysis.",
      };
    }
    if (job.status === "pending") return { status: "pending" };
    if (job.status === "failed") {
      return { status: "failed", error: job.error ?? "Analysis failed." };
    }
    return { status: "complete", result: job.result as ClaudeCallResult };
  });
