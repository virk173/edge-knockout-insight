// Server-only background-job store for Claude analyses.
//
// WHY: The Claude call used to run as a direct browser fetch. On mobile, when
// the tab is backgrounded, JS execution is throttled and the in-flight fetch is
// killed — losing a 60-120s analysis. Moving the call server-side and polling
// for the result decouples completion from the browser staying in the
// foreground.
//
// The store is a module-level Map that lives for the lifetime of the worker
// isolate. Polling (every 3s) keeps the isolate warm so the fire-and-forget
// Claude promise keeps executing between poll requests. If the isolate is
// evicted / the worker restarts, the Map is lost and the job id is no longer
// found — `getJob` then returns null and the polling endpoint reports the job
// as expired, which the client surfaces with a Retry action. Records also
// self-expire after 10 minutes.

import { callClaude, type ClaudeCallInput, type ClaudeCallResult } from "./claude.server";

export type JobStatus = "pending" | "complete" | "failed";

interface JobRecord {
  status: JobStatus;
  // For a completed job this is the raw callClaude return value ({ ok, data } or
  // { ok:false, ... }). The client parses + enriches it exactly as it did with
  // the synchronous response, so calculateResults() stays client-side.
  result?: ClaudeCallResult;
  error?: string;
  createdAt: number;
  finishedAt?: number;
}

const JOB_TTL_MS = 10 * 60 * 1000; // 10 minutes

// globalThis pin so hot-module-reload / repeated dynamic imports in dev reuse
// the same Map instead of creating a fresh one each time.
const g = globalThis as unknown as { __edgeAnalysisJobs?: Map<string, JobRecord> };
const jobs: Map<string, JobRecord> = g.__edgeAnalysisJobs ?? new Map();
g.__edgeAnalysisJobs = jobs;

function sweepExpired(): void {
  const now = Date.now();
  for (const [id, rec] of jobs) {
    if (now - rec.createdAt > JOB_TTL_MS) jobs.delete(id);
  }
}

export function createJob(): string {
  sweepExpired();
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `job_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  jobs.set(id, { status: "pending", createdAt: Date.now() });
  return id;
}

export function getJob(id: string): JobRecord | null {
  sweepExpired();
  return jobs.get(id) ?? null;
}

/**
 * Fire-and-forget execution of the Claude call for a job. Never rejects — it
 * always records a terminal state on the job. The caller does NOT await this.
 */
export function runJob(id: string, input: ClaudeCallInput): void {
  void (async () => {
    try {
      const result = await callClaude(input);
      const rec = jobs.get(id);
      if (!rec) return; // expired / swept while running
      // callClaude resolving (even with ok:false for billing/timeout) is a
      // COMPLETE job — the client's existing result handler distinguishes ok
      // vs. billing/timeout/error. "failed" is reserved for thrown exceptions
      // and expiry so the client can offer a plain Retry.
      rec.status = "complete";
      rec.result = result;
      rec.finishedAt = Date.now();
    } catch (e) {
      const rec = jobs.get(id);
      if (!rec) return;
      rec.status = "failed";
      rec.error = e instanceof Error ? e.message : "Analysis job failed unexpectedly.";
      rec.finishedAt = Date.now();
    }
  })();
}
