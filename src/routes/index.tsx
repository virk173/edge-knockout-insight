import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  runAnalysis,
  STATUS_META,
  timingBand,
  isMatchBlocked,
  type AnalysedMatch,
  type TimingBand,
} from "@/lib/fixtures";
import {
  readFixturesCache,
  writeFixturesCache,
  isStale,
  formatAgo,
} from "@/lib/fixturesCache";
import {
  collectMatchData,
  formatDataForClaude,
  refetchLineups,
  retrySingleCall,
  buildCallPanelSummary,
  LINEUP_STATE_INFO,
  type CollectionResult,
  type ProgressUpdate,
} from "@/lib/analyse";
import { clearMatchCache } from "@/lib/callCache";
import { CallStatusPanel } from "@/components/betting/CallStatusPanel";
import type { AnalysisResult } from "@/lib/analysisResult";
import { calculateEnsembleAlignment, calculateResults } from "@/lib/calculate";
import {
  readResultCache,
  writeResultCache,
  extractSgpChain,
  formatResultAgo,
} from "@/lib/resultCache";
import { BettingDashboard } from "@/components/betting/BettingDashboard";
import { SkeletonDashboard } from "@/components/betting/SkeletonDashboard";
import { BacktestLog } from "@/components/betting/BacktestLog";
import {
  appendLogEntry,
  getLogEntries,
  setRecommendationOutcome,
  clearLog,
  type LogEntry,
  type Outcome,
} from "@/lib/backtestLog";
import {
  getApiCallCount,
  budgetLevel,
  DAILY_LIMIT,
  WARNING_THRESHOLD,
  CRITICAL_THRESHOLD,
} from "@/lib/apiCounter";
import { SYSTEM_PROMPT } from "@/lib/systemPrompt";
import {
  startAnalysis,
  getAnalysisResult,
} from "@/lib/analysisJobs.functions";
import type { ClaudeCallResult } from "@/lib/claude.server";
import { formatMatchTime } from "@/lib/formatMatchTime";
import { BarChart3, HelpCircle } from "lucide-react";

const CLAUDE_LOADING_MESSAGES = [
  "Sending data to Claude...",
  "Claude is processing match data...",
  "Receiving analysis...",
  "Running calculations...",
  "Building recommendations...",
];

const CLAUDE_MAX_SECONDS = 180;

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Edge — WC2026 Betting Engine" },
      { name: "description", content: "WC2026 Knockout Intelligence betting engine." },
      { property: "og:title", content: "Edge — WC2026 Betting Engine" },
      { property: "og:description", content: "WC2026 Knockout Intelligence betting engine." },
    ],
  }),
  component: Index,
});

function formatUtc(date: Date): string {
  return (
    date.toISOString().slice(0, 10) +
    " " +
    date.toISOString().slice(11, 19) +
    " UTC"
  );
}

function formatLocal(iso: string): string {
  return formatMatchTime(iso) ?? "—";
}

// Lineups for WC2026 are expected to drop ~75 min before kickoff.
const LINEUP_DROP_MIN = 75;
// Option B — final near-kickoff re-check at T-15.
const LINEUP_FINAL_RECHECK_MIN = 15;

function minutesUntil(iso: string, now: Date): number {
  return Math.round((new Date(iso).getTime() - now.getTime()) / 60000);
}

function fmtMinutes(mins: number): string {
  if (mins <= 0) return "now";
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function formatMaxSeconds(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function friendlyError(raw: string): string {
  const m = raw.toLowerCase();
  if (
    m.includes("apifootball_key") ||
    m.includes("vite_apifootball") ||
    m.includes("api key") ||
    m.includes("not configured") ||
    (m.includes("missing") && m.includes("key"))
  ) {
    return "API key not configured.\nAdd VITE_APIFOOTBALL_KEY to your environment variables.";
  }
  return raw;
}

const HOW_TO_TEXT = `Best time to run: 60-90 minutes before kickoff when lineups are confirmed and odds are sharpest.

This tool analyses:
- Team form and statistics
- Head-to-head history
- Confirmed lineups and injuries
- Referee profile
- Stake odds with EV calculation
- Pinnacle line movement

Output: Tier 1 anchor bet + Tier 2 same-game parlay + Tier 3 jackpot (CLASS C matches only)

Total stake per match: $50
Do not bet unallocated amounts.`;

function timingBannerClass(tone: TimingBand["tone"]): string {
  switch (tone) {
    case "green":
      return "border-signal-green/50 bg-signal-green/10 text-signal-green";
    case "amber":
      return "border-accent-amber/50 bg-accent-amber/10 text-accent-amber";
    case "red":
      return "border-signal-red/60 bg-signal-red/10 text-signal-red";
    case "blocked":
      return "border-signal-red/60 bg-signal-red/10 text-signal-red";
    default:
      return "border-border bg-card/40 text-slate";
  }
}

// ─────────────────────────────────────────────────────────────
// Per-match state map. Navigating list ↔ match preserves everything.
// ─────────────────────────────────────────────────────────────
interface MatchState {
  collection: CollectionResult | null;
  collectError: string | null;
  progress: ProgressUpdate | null;
  analysisResult: unknown;
  analysisRaw: string | null;
  analysisError: string | null;
  billingError: boolean;
  tokenUsage: { input: number; output: number } | null;
  analysing: boolean;
  retrying: string[];
  lastRunAt: number | null;
  analysisSavedAt: number | null; // when the persisted result was written
  loadedFromCache: boolean; // true when analysisResult was hydrated from localStorage
  analysisJobId: string | null; // id of the in-flight background analysis job
  analysisCompletedAway: boolean; // job finished while the tab was backgrounded
  pollStalled: boolean; // polling failed 5x in a row — show a Retry button
}

const EMPTY_MATCH_STATE: MatchState = {
  collection: null,
  collectError: null,
  progress: null,
  analysisResult: null,
  analysisRaw: null,
  analysisError: null,
  billingError: false,
  tokenUsage: null,
  analysing: false,
  retrying: [],
  lastRunAt: null,
  analysisSavedAt: null,
  loadedFromCache: false,
  analysisJobId: null,
  analysisCompletedAway: false,
  pollStalled: false,
};

// ─────────────────────────────────────────────────────────────
// Background-analysis polling
// ─────────────────────────────────────────────────────────────
interface PollController {
  timer: ReturnType<typeof setInterval> | null;
  jobId: string;
  failCount: number;
  startedAt: number;
  canceled: boolean;
  inFlight: boolean;
}

const POLL_INTERVAL_MS = 3000;
const MAX_POLL_FAILURES = 5;
const jobStorageKey = (matchId: number) => `edge_job_${matchId}`;

type Tab = "analysis" | "log";
type View = "fixtures" | "match";

function Index() {
  const [now, setNow] = useState(() => new Date());
  const [tab, setTab] = useState<Tab>("analysis");
  const [view, setView] = useState<View>("fixtures");
  const [activeMatchId, setActiveMatchId] = useState<number | null>(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [matches, setMatches] = useState<AnalysedMatch[] | null>(null);
  const [fixturesFetchedAt, setFixturesFetchedAt] = useState<number | null>(null);
  const [apiCalls, setApiCalls] = useState(0);
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);

  const [matchStates, setMatchStates] = useState<Record<number, MatchState>>({});
  const [analysisMsgIndex, setAnalysisMsgIndex] = useState(0);
  const [analysisElapsedSec, setAnalysisElapsedSec] = useState(0);

  const callStartAnalysis = useServerFn(startAnalysis);
  const callGetAnalysisResult = useServerFn(getAnalysisResult);
  const msgTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const lineupRefetchedRef = useRef<Set<number>>(new Set());
  const lineupFinalRecheckRef = useRef<Set<number>>(new Set());
  // Active analysis-poll controllers, keyed by match id. Lets a background job
  // keep being polled independently of which match view is open.
  const pollControllers = useRef<Map<number, PollController>>(new Map());
  // Match ids whose analysis was running while the tab was backgrounded — used
  // to show the "completed while you were away" banner on return.
  const backgroundedRef = useRef<Set<number>>(new Set());

  // Helpers to read/patch per-match state.
  const getState = (id: number | null): MatchState =>
    id != null ? (matchStates[id] ?? EMPTY_MATCH_STATE) : EMPTY_MATCH_STATE;
  const patchState = (id: number, partial: Partial<MatchState>) =>
    setMatchStates((prev) => ({
      ...prev,
      [id]: { ...(prev[id] ?? EMPTY_MATCH_STATE), ...partial },
    }));

  const activeMatch =
    activeMatchId != null && matches
      ? matches.find((m) => m.id === activeMatchId) ?? null
      : null;
  const activeState = getState(activeMatchId);

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  // Clear any live poll timers when the component unmounts.
  useEffect(() => {
    const controllers = pollControllers.current;
    return () => {
      for (const c of controllers.values()) {
        c.canceled = true;
        if (c.timer) clearInterval(c.timer);
      }
      controllers.clear();
    };
  }, []);


  useEffect(() => {
    setApiCalls(getApiCallCount());
    setLogEntries(getLogEntries());
    // Load whatever fixtures list is already cached for today — NO fetch.
    // A fresh fetch only happens when the user clicks the Find/Refresh button.
    const cached = readFixturesCache();
    if (cached) {
      setMatches(cached.matches);
      setFixturesFetchedAt(cached.fetchedAt);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Hydrate persisted analysis results (localStorage) into matchStates whenever
  // the fixtures list changes — so a reload restores the "✓ Analysed" indicator
  // and opening a match shows its saved result without a fresh Claude call.
  useEffect(() => {
    if (!matches) return;
    setMatchStates((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const m of matches) {
        const existing = prev[m.id];
        if (existing?.analysisResult) continue; // fresh in-memory result wins
        const cached = readResultCache(m.id);
        if (!cached) continue;
        next[m.id] = {
          ...(existing ?? EMPTY_MATCH_STATE),
          analysisResult: cached.result,
          analysisRaw: cached.rawClaudeJson,
          tokenUsage: cached.tokenUsage,
          analysisSavedAt: cached.savedAt,
          loadedFromCache: true,
        };
        changed = true;
      }
      return changed ? next : prev;
    });
  }, [matches]);

  // Resume any in-flight background analysis jobs when fixtures load or when the
  // tab regains focus after being backgrounded. If a job finished while away,
  // the poll picks up the completed result and the "away" banner is shown.
  useEffect(() => {
    if (!matches) return;

    const resumeAll = (markAway: boolean) => {
      for (const m of matches) resumeIfPending(m.id, markAway);
    };

    // When the tab goes hidden, flag any actively-analysing matches so that a
    // completion that happens while hidden surfaces the "while you were away"
    // banner on return.
    const onHidden = () => {
      for (const m of matches) {
        const st = matchStates[m.id];
        if (st?.analysing || pollControllers.current.has(m.id)) {
          backgroundedRef.current.add(m.id);
        }
      }
    };

    // Initial mount: resume without treating as "away".
    resumeAll(false);

    const onVisibility = () => {
      if (document.visibilityState === "hidden") onHidden();
      else resumeAll(true);
    };
    const onFocus = () => resumeAll(true);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matches]);



  function handleCycleOutcome(entryId: string, recIndex: number, next: Outcome) {
    setLogEntries(setRecommendationOutcome(entryId, recIndex, next));
  }

  function handleClearLog() {
    setLogEntries(clearLog());
  }

  // Cycle Claude loading messages + elapsed timer while the active match analyses.
  useEffect(() => {
    if (!activeState.analysing) {
      if (msgTimer.current) clearInterval(msgTimer.current);
      msgTimer.current = null;
      return;
    }
    setAnalysisMsgIndex(0);
    setAnalysisElapsedSec(0);
    msgTimer.current = setInterval(() => {
      setAnalysisElapsedSec((seconds) => {
        const next = seconds + 1;
        if (next % 3 === 0) {
          setAnalysisMsgIndex((i) => (i + 1) % CLAUDE_LOADING_MESSAGES.length);
        }
        return next;
      });
    }, 1000);
    return () => {
      if (msgTimer.current) clearInterval(msgTimer.current);
      msgTimer.current = null;
    };
  }, [activeState.analysing]);

  // Auto re-fetch lineups (CALL 6) when they came back PENDING. Runs against the
  // currently-open match: once at the ~T-75 drop window, once at the ~T-15 final
  // re-check.
  useEffect(() => {
    if (activeMatchId == null || !matches) return;
    const st = matchStates[activeMatchId];
    if (!st || !st.collection) return;
    const match = matches.find((m) => m.id === activeMatchId);
    if (!match) return;
    const c6 = st.collection.callResults["6"];
    const pending = !c6 || c6.status !== "SUCCESS";
    if (!pending) return;
    const mins = minutesUntil(match.kickoffUtc, now);
    if (mins <= 0) return;

    const runRefetch = async (phase: "drop" | "final") => {
      const updated = await refetchLineups(match);
      setMatchStates((prev) => {
        const cur = prev[match.id];
        if (!cur || !cur.collection) return prev;
        return {
          ...prev,
          [match.id]: {
            ...cur,
            collection: {
              ...cur.collection,
              callResults: { ...cur.collection.callResults, "6": updated },
            },
          },
        };
      });
      setApiCalls(getApiCallCount());
      if (updated.status === "SUCCESS") {
        toast.success("Confirmed lineups now available — re-analyse for full data.");
      } else if (phase === "final") {
        toast.warning(
          "Final lineup re-check at T-15: starting XI still not populated. Proceeding without confirmed XI.",
        );
      }
    };

    if (
      mins <= LINEUP_FINAL_RECHECK_MIN &&
      !lineupFinalRecheckRef.current.has(match.id)
    ) {
      lineupFinalRecheckRef.current.add(match.id);
      void runRefetch("final");
      return;
    }
    if (
      mins <= LINEUP_DROP_MIN &&
      mins > LINEUP_FINAL_RECHECK_MIN &&
      !lineupRefetchedRef.current.has(match.id)
    ) {
      lineupRefetchedRef.current.add(match.id);
      void runRefetch("drop");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [now, activeMatchId, matches]);

  // Explicit fetch — only called from the Find Fixtures / Refresh button.
  async function loadFixtures() {
    setLoading(true);
    setError(null);
    try {
      const result = await runAnalysis();
      setMatches(result.matches);
      const entry = writeFixturesCache(result.matches);
      setFixturesFetchedAt(entry.fetchedAt);
      setApiCalls(getApiCallCount());
    } catch (e) {
      // On failure keep the previously cached list visible.
      setError(friendlyError(e instanceof Error ? e.message : "Unknown error occurred."));
    } finally {
      setLoading(false);
    }
  }

  // Navigation helpers — preserve match state.
  function openMatch(match: AnalysedMatch) {
    setActiveMatchId(match.id);
    setView("match");
  }
  function backToFixtures() {
    setView("fixtures");
  }

  // ── Background-job analysis ────────────────────────────────
  // Stop polling a match's job and drop its controller.
  function cancelPolling(matchId: number) {
    const c = pollControllers.current.get(matchId);
    if (c) {
      c.canceled = true;
      if (c.timer) clearInterval(c.timer);
      pollControllers.current.delete(matchId);
    }
  }

  // Process a completed Claude response — identical logic to the old
  // synchronous success/error path. calculateResults() still runs here,
  // client-side, on the returned raw response.
  function processClaudeResponse(
    match: AnalysedMatch,
    res: ClaudeCallResult,
    startedAt: number,
    away: boolean,
  ) {
    const responseTimeMs = Date.now() - startedAt;

    if (!res || !res.ok) {
      if ((res as { error_type?: string } | null)?.error_type === "BILLING") {
        patchState(match.id, {
          billingError: true,
          analysing: false,
          analysisJobId: null,
        });
        toast.error("Anthropic billing issue", {
          description: "Account credit balance is too low.",
        });
        return;
      }
      const msg =
        res?.error ??
        "The analysis service did not return a response. It may have timed out — please try again.";
      patchState(match.id, {
        analysisError: msg,
        analysing: false,
        analysisJobId: null,
      });
      toast.error("Analysis failed", { description: msg });
      return;
    }

    const text: string = res.data?.content?.[0]?.text ?? "";
    const usage = res.data?.usage;
    const tokenUsage = usage
      ? { input: usage.input_tokens ?? 0, output: usage.output_tokens ?? 0 }
      : null;
    const cleaned = text.replace(/```json|```/g, "").trim();

    const tryParse = (): unknown => {
      try {
        return JSON.parse(cleaned);
      } catch {
        const start = cleaned.indexOf("{");
        const end = cleaned.lastIndexOf("}");
        if (start !== -1 && end !== -1 && end > start) {
          return JSON.parse(cleaned.slice(start, end + 1));
        }
        throw new Error("No JSON object found in response.");
      }
    };

    try {
      const parsed = tryParse();
      const enriched = calculateResults(parsed);
      const savedAt = Date.now();
      patchState(match.id, {
        analysisRaw: cleaned,
        analysisResult: enriched,
        tokenUsage,
        analysing: false,
        analysisSavedAt: savedAt,
        loadedFromCache: false,
        analysisJobId: null,
        analysisCompletedAway: away,
      });
      writeResultCache({
        matchId: match.id,
        match: `${match.home} vs ${match.away}`,
        result: enriched as AnalysisResult,
        rawClaudeJson: cleaned,
        sgpChain: extractSgpChain(enriched as AnalysisResult),
        tokenUsage,
        responseTimeMs,
        savedAt,
      });
      toast.success(away ? "Analysis completed while you were away" : "Analysis complete");

      const logEntry = enriched?.log_entry;
      if (logEntry && typeof logEntry === "object") {
        const updated = appendLogEntry(logEntry);
        setLogEntries(updated);
        toast.success("Saved to backtesting log");
      }
    } catch {
      const head = cleaned.slice(0, 500);
      const tail = cleaned.length > 500 ? cleaned.slice(-500) : "";
      patchState(match.id, {
        analysisRaw: cleaned,
        tokenUsage,
        analysing: false,
        analysisJobId: null,
        analysisError: `Analysis could not be parsed.\nCommon causes: max_tokens too low, API key invalid, network timeout.\n\n--- FIRST 500 CHARS ---\n${head}\n\n--- LAST 500 CHARS ---\n${tail}`,
      });
      toast.error("Could not parse analysis JSON");
    }
  }

  // Start polling a job every 3s. `away` marks completions that should show the
  // "completed while you were away" banner.
  function startPolling(
    match: AnalysedMatch,
    jobId: string,
    startedAt: number,
    away: boolean,
  ) {
    cancelPolling(match.id);
    const controller: PollController = {
      timer: null,
      jobId,
      failCount: 0,
      startedAt,
      canceled: false,
      inFlight: false,
    };
    pollControllers.current.set(match.id, controller);
    patchState(match.id, {
      analysing: true,
      analysisJobId: jobId,
      pollStalled: false,
      analysisError: null,
      billingError: false,
    });

    const tick = async () => {
      if (controller.canceled || controller.inFlight) return;
      controller.inFlight = true;
      try {
        const poll = await callGetAnalysisResult({ data: { jobId } });
        controller.failCount = 0;
        if (controller.canceled) return;
        if (poll.status === "pending") return;
        if (poll.status === "failed") {
          cancelPolling(match.id);
          try {
            localStorage.removeItem(jobStorageKey(match.id));
          } catch {
            /* ignore */
          }
          patchState(match.id, {
            analysing: false,
            analysisJobId: null,
            analysisError: poll.error,
          });
          toast.error("Analysis failed", { description: poll.error });
          return;
        }
        // complete
        cancelPolling(match.id);
        try {
          localStorage.removeItem(jobStorageKey(match.id));
        } catch {
          /* ignore */
        }
        const wasAway = away || backgroundedRef.current.has(match.id);
        backgroundedRef.current.delete(match.id);
        processClaudeResponse(match, poll.result, controller.startedAt, wasAway);
      } catch {
        controller.failCount += 1;
        if (controller.failCount >= MAX_POLL_FAILURES) {
          cancelPolling(match.id);
          patchState(match.id, { analysing: false, pollStalled: true });
          toast.error("Lost connection to the analysis", {
            description: "Tap Retry to resume from where it left off.",
          });
        }
      } finally {
        controller.inFlight = false;
      }
    };

    controller.timer = setInterval(tick, POLL_INTERVAL_MS);
    void tick(); // immediate first poll
  }

  // Resume polling a stored job for a match if one exists and we're not already
  // polling and don't already have a result. Called on returning from
  // background / opening a match.
  function resumeIfPending(matchId: number, markAway = true) {
    if (pollControllers.current.has(matchId)) return;
    let jobId: string | null = null;
    try {
      jobId = localStorage.getItem(jobStorageKey(matchId));
    } catch {
      jobId = null;
    }
    if (!jobId) return;
    const st = getState(matchId);
    if (st.analysisResult) return;
    const match = matches?.find((m) => m.id === matchId);
    if (!match) return;
    startPolling(match, jobId, Date.now(), markAway);
  }

  // Start a fresh analysis job. If one is already running for this match, cancel
  // its poll first and replace it.
  async function runClaudeAnalysis(match: AnalysedMatch, result: CollectionResult) {
    cancelPolling(match.id);
    backgroundedRef.current.delete(match.id);
    patchState(match.id, {
      analysing: true,
      analysisResult: null,
      analysisError: null,
      billingError: false,
      analysisRaw: null,
      tokenUsage: null,
      analysisJobId: null,
      analysisCompletedAway: false,
      pollStalled: false,
    });

    let formattedData: string;
    try {
      formattedData = formatDataForClaude(result.callResults);
    } catch (e) {
      console.error("formatDataForClaude failed:", e);
      formattedData = "No usable API data could be formatted for analysis.";
    }

    const userMessage = `Analyse this World Cup 2026 knockout match using ONLY the injected API data below. Do not use any knowledge from training data for statistics or odds.

MATCH: ${match.home} vs ${match.away}
FIXTURE ID: ${match.id}
ROUND: ${match.round ?? "NOT_AVAILABLE"}
KICKOFF UTC: ${match.kickoffUtc}
CURRENT TIME UTC: ${new Date().toISOString()}
VENUE: ${match.venueName ?? "NOT_AVAILABLE"}
VENUE CITY: ${match.venueCity ?? "NOT_AVAILABLE"}
LINEUP STATUS: ${LINEUP_STATE_INFO[result.lineupState].label} — ${LINEUP_STATE_INFO[result.lineupState].note}${result.lineupState === "POPULATED" ? "" : " Apply the LINEUP-UNAVAILABLE confidence penalty; a PROPAGATING state (lineup confirmed to exist but XI not yet split out) warrants a SMALLER penalty than NOT_ANNOUNCED."}

INJECTED API DATA:

${formattedData}

Generate the complete JSON output exactly as specified in the system prompt.
Return ONLY valid JSON.
No markdown fences.
No explanation outside the JSON.
Start your response with { and end with }.`;

    const startedAt = Date.now();
    try {
      const { jobId } = await callStartAnalysis({
        data: { systemPrompt: SYSTEM_PROMPT, userMessage },
      });
      try {
        localStorage.setItem(jobStorageKey(match.id), jobId);
      } catch {
        /* ignore */
      }
      startPolling(match, jobId, startedAt, false);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Could not start the analysis job.";
      patchState(match.id, {
        analysisError: msg,
        analysing: false,
        analysisJobId: null,
      });
      toast.error("Analysis failed", { description: msg });
    }
  }

  // Resume polling after a 5-failure stall, using the stored job id.
  function handleResumePoll(match: AnalysedMatch) {
    let jobId = getState(match.id).analysisJobId;
    if (!jobId) {
      try {
        jobId = localStorage.getItem(jobStorageKey(match.id));
      } catch {
        jobId = null;
      }
    }
    if (!jobId) {
      toast.error("No job to resume — re-run analysis.");
      return;
    }
    startPolling(match, jobId, Date.now(), true);
  }


  // SECTION 1 — Run All Calls. API pipeline only. No Claude / tokens.
  async function handleRunCalls(match: AnalysedMatch) {
    lineupRefetchedRef.current.delete(match.id);
    lineupFinalRecheckRef.current.delete(match.id);
    patchState(match.id, {
      collection: null,
      collectError: null,
      analysisResult: null,
      analysisError: null,
      analysisRaw: null,
      tokenUsage: null,
      progress: { step: 0, total: 11, label: "Starting data collection…" },
    });

    try {
      const result = await collectMatchData(
        match,
        (p) => patchState(match.id, { progress: p }),
        { debug: false },
      );
      patchState(match.id, {
        collection: result,
        progress: null,
        lastRunAt: Date.now(),
      });
      setApiCalls(getApiCallCount());
      toast.success("Calls complete — ready to analyse");
    } catch (e) {
      patchState(match.id, {
        collectError: friendlyError(
          e instanceof Error ? e.message : "Data collection failed.",
        ),
        progress: null,
      });
      setApiCalls(getApiCallCount());
    }
  }

  // SECTION 2 — Analyse cached data with Claude.
  async function handleAnalyseCached(match: AnalysedMatch) {
    const st = getState(match.id);
    if (!st.collection) {
      toast.error("Run calls first.");
      return;
    }
    await runClaudeAnalysis(match, st.collection);
  }

  async function handleRetryCall(match: AnalysedMatch, retryKey: string) {
    patchState(match.id, { retrying: [...getState(match.id).retrying, retryKey] });
    try {
      const updated = await retrySingleCall(match, retryKey);
      setMatchStates((prev) => {
        const cur = prev[match.id];
        if (!cur || !cur.collection) return prev;
        return {
          ...prev,
          [match.id]: {
            ...cur,
            collection: {
              ...cur.collection,
              callResults: { ...cur.collection.callResults, ...updated },
            },
          },
        };
      });
      setApiCalls(getApiCallCount());
      const ok = Object.values(updated).some((r) => r.status === "SUCCESS");
      if (ok) toast.success(`Retried ${retryKey} — updated`);
      else toast.warning(`Retried ${retryKey} — still no data`);
    } catch (e) {
      toast.error(`Retry failed: ${e instanceof Error ? e.message : "unknown error"}`);
    } finally {
      patchState(match.id, {
        retrying: getState(match.id).retrying.filter((k) => k !== retryKey),
      });
    }
  }

  // Resume Calls — retry only the calls that FAILED (or never completed), leaving
  // successful/cached calls untouched. Effectively clicks every failed call's
  // per-call retry button at once, sequentially to respect rate limits.
  async function handleResumeCalls(match: AnalysedMatch) {
    const st = getState(match.id);
    if (!st.collection) return;
    const summary = buildCallPanelSummary(st.collection.callResults);
    const keys = summary.rows
      .filter((r) => r.status === "FAILED" && r.spec.retryKey)
      .map((r) => r.spec.retryKey as string);
    // De-dupe (some rows share a retryKey, e.g. C7/S7).
    const uniqueKeys = Array.from(new Set(keys));
    if (uniqueKeys.length === 0) {
      toast.info("No incomplete calls to resume.");
      return;
    }
    toast.info(`Resuming ${uniqueKeys.length} incomplete call${uniqueKeys.length > 1 ? "s" : ""}…`);
    for (const k of uniqueKeys) {
      await handleRetryCall(match, k);
    }
  }


  function handleClearMatchCache(match: AnalysedMatch) {
    clearMatchCache(match.id);
    patchState(match.id, {
      collection: null,
      collectError: null,
      analysisResult: null,
      analysisRaw: null,
    });
    toast.success("Cache cleared — run calls again for a fresh fetch");
  }

  function handleResetBudget() {
    const confirmed = window.confirm(
      "Reset today's API call counter to 0? This does not affect actual API usage limits — it only resets the local counter.",
    );
    if (!confirmed) return;
    const today = new Date().toISOString().slice(0, 10);
    window.localStorage.removeItem(`apifootball_calls_${today}`);
    setApiCalls(getApiCallCount());
    toast.success("API budget counter reset to 0");
  }

  const counterWarning = apiCalls >= WARNING_THRESHOLD;
  const counterCritical = apiCalls >= CRITICAL_THRESHOLD;
  const apiLevel = budgetLevel(apiCalls);
  const apiColorClass =
    apiLevel === "critical" || apiLevel === "warning"
      ? "text-signal-red"
      : apiLevel === "amber"
        ? "text-accent-amber"
        : "text-slate";

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-6 py-4">
        <div className="flex items-baseline gap-3">
          <span className="text-2xl font-bold tracking-tight text-foreground">EDGE</span>
          <span className="text-sm font-medium text-slate">WC2026 Knockout Intelligence</span>
        </div>

        <nav className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => {
              setTab("analysis");
              setView("fixtures");
            }}
            className={`rounded-md px-3 py-1.5 text-xs font-semibold uppercase tracking-wide transition-colors ${
              tab === "analysis"
                ? "bg-accent-amber text-black"
                : "text-slate hover:text-foreground"
            }`}
          >
            Fixtures
          </button>
          <button
            type="button"
            onClick={() => setTab("log")}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold uppercase tracking-wide transition-colors ${
              tab === "log"
                ? "bg-accent-amber text-black"
                : "text-slate hover:text-foreground"
            }`}
          >
            <BarChart3 size={14} />
            Backtest Log
          </button>
        </nav>

        <div className="flex items-center gap-4">
          <span
            className={`rounded-md border border-border px-2.5 py-1 font-mono text-xs font-semibold ${apiColorClass}`}
            title="API-Football calls used today (resets at midnight UTC)"
          >
            API: {apiCalls}/{DAILY_LIMIT}
          </span>
        </div>
      </header>

      {tab === "log" ? (
        <main className="flex flex-1 flex-col items-center px-6 py-10">
          <BacktestLog
            entries={logEntries}
            onCycleOutcome={handleCycleOutcome}
            onClear={handleClearLog}
          />
        </main>
      ) : view === "fixtures" ? (
        <FixturesView
          matches={matches}
          loading={loading}
          error={error}
          now={now}
          apiCalls={apiCalls}
          apiColorClass={apiColorClass}
          counterWarning={counterWarning}
          counterCritical={counterCritical}
          onRefresh={loadFixtures}
          onOpenMatch={openMatch}
          matchStates={matchStates}
          fetchedAt={fixturesFetchedAt}
        />
      ) : activeMatch ? (
        <MatchView
          match={activeMatch}
          state={activeState}
          now={now}
          retrying={new Set(activeState.retrying)}
          analysisMsgIndex={analysisMsgIndex}
          analysisElapsedSec={analysisElapsedSec}
          onBack={backToFixtures}
          onRunCalls={() => handleRunCalls(activeMatch)}
          onAnalyse={() => handleAnalyseCached(activeMatch)}
          onRetry={(k) => handleRetryCall(activeMatch, k)}
          onResumeCalls={() => handleResumeCalls(activeMatch)}
          onResumePoll={() => handleResumePoll(activeMatch)}
          onClearCache={() => handleClearMatchCache(activeMatch)}
          onResetBudget={handleResetBudget}
          patchState={(partial) => patchState(activeMatch.id, partial)}
        />
      ) : (
        <main className="flex flex-1 flex-col items-center px-6 py-10">
          <p className="text-lg font-medium text-slate">Match not found.</p>
          <button
            type="button"
            onClick={backToFixtures}
            className="mt-4 text-sm text-accent-amber underline"
          >
            ← Back to fixtures
          </button>
        </main>
      )}

      <footer className="flex flex-col items-center gap-1 border-t border-border px-6 py-4 text-center">
        <span className="text-xs font-semibold text-foreground">
          Edge v4.0 — WC2026 Knockout Intelligence
        </span>
        <span className="text-xs text-slate">
          Not financial advice. Bet responsibly.
        </span>
        <span className="font-mono text-xs text-slate">
          API calls today: <span className={apiColorClass}>{apiCalls}</span>/
          {DAILY_LIMIT}
        </span>
        <span className="mt-1 font-mono text-sm text-slate" suppressHydrationWarning>
          {formatUtc(now)}
        </span>
      </footer>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// FIXTURES VIEW
// ─────────────────────────────────────────────────────────────
function FixturesView({
  matches,
  loading,
  error,
  now,
  apiCalls,
  apiColorClass,
  counterWarning,
  counterCritical,
  onRefresh,
  onOpenMatch,
  matchStates,
  fetchedAt,
}: {
  matches: AnalysedMatch[] | null;
  loading: boolean;
  error: string | null;
  now: Date;
  apiCalls: number;
  apiColorClass: string;
  counterWarning: boolean;
  counterCritical: boolean;
  onRefresh: () => void;
  onOpenMatch: (m: AnalysedMatch) => void;
  matchStates: Record<number, MatchState>;
  fetchedAt: number | null;
}) {
  const sorted = matches
    ? [...matches].sort(
        (a, b) =>
          new Date(a.kickoffUtc).getTime() - new Date(b.kickoffUtc).getTime(),
      )
    : null;

  const nowMs = now.getTime();
  const hasCache = fetchedAt != null;
  const stale = hasCache && isStale(fetchedAt, nowMs);
  const buttonLabel = loading
    ? "Loading fixtures…"
    : hasCache
      ? "↻ Refresh"
      : "Find Fixtures";

  return (
    <main className="flex flex-1 flex-col items-center px-6 py-10">
      <div className="flex w-full max-w-2xl flex-col gap-6">
        <div className="flex flex-col items-center gap-3">
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold text-foreground">Edge — WC2026</h1>
            <div className="group relative">
              <button
                type="button"
                aria-label="How to use this tool"
                className="grid h-7 w-7 place-items-center rounded-full border border-border text-slate transition-colors hover:border-accent-amber hover:text-accent-amber focus:border-accent-amber focus:text-accent-amber focus:outline-none"
              >
                <HelpCircle size={16} />
              </button>
              <div className="pointer-events-none absolute left-1/2 top-full z-20 mt-2 w-72 max-w-[80vw] -translate-x-1/2 whitespace-pre-line rounded-md border border-border bg-card p-3 text-left text-xs leading-relaxed text-slate opacity-0 shadow-lg transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
                {HOW_TO_TEXT}
              </div>
            </div>
          </div>
          <p className="text-sm font-medium text-slate">Upcoming Fixtures</p>
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className="rounded-md bg-accent-amber px-5 py-2 text-xs font-bold uppercase tracking-wide text-black transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {buttonLabel}
          </button>
          {hasCache && !loading && (
            <span
              className={`font-mono text-xs ${stale ? "text-accent-amber" : "text-slate"}`}
            >
              Last updated: {formatAgo(fetchedAt, nowMs)}
              {stale ? " — may be outdated" : ""}
            </span>
          )}
          <span className="font-mono text-xs text-slate">
            API calls used today:{" "}
            <span className={apiColorClass}>{apiCalls}</span>/{DAILY_LIMIT}
          </span>
        </div>

        {counterCritical ? (
          <div className="w-full rounded-md border border-signal-red/60 bg-signal-red/10 px-4 py-3 text-sm font-semibold text-signal-red">
            🚫 API budget critical at {apiCalls}/{DAILY_LIMIT} today. Only
            essential calls running.
          </div>
        ) : counterWarning ? (
          <div className="w-full rounded-md border border-accent-amber/50 bg-accent-amber/10 px-4 py-3 text-sm text-accent-amber">
            ⚠️ API budget at {apiCalls}/{DAILY_LIMIT} today. Predictions/bracket
            calls may be skipped.
          </div>
        ) : null}

        {error && (
          <div className="w-full whitespace-pre-line rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {loading && !sorted && (
          <p className="pt-10 text-center text-lg font-medium text-slate">
            Loading fixtures…
          </p>
        )}

        {!sorted && !loading && (
          <div className="w-full rounded-md border border-border bg-card/40 px-4 py-8 text-center text-sm text-slate">
            No fixtures loaded yet. Tap{" "}
            <span className="font-semibold text-accent-amber">Find Fixtures</span>{" "}
            to load today's and tomorrow's matches.
          </div>
        )}

        {sorted && sorted.length === 0 && (
          <div className="w-full rounded-md border border-border bg-card/40 px-4 py-5 text-center text-sm text-slate">
            No World Cup matches scheduled today or tomorrow. Check back closer to
            the next knockout fixtures.
          </div>
        )}

        {sorted && sorted.length > 0 && (
          <ul className="flex w-full flex-col gap-3">
            {sorted.map((m) => {
              const minsToKickoff = minutesUntil(m.kickoffUtc, now);
              const blocked = isMatchBlocked(m.statusShort, minsToKickoff);
              const band = timingBand(minsToKickoff, blocked);
              const meta = STATUS_META[m.status];
              const hasState = !!matchStates[m.id]?.collection;
              const hasResult = !!matchStates[m.id]?.analysisResult;
              const savedAt = matchStates[m.id]?.analysisSavedAt ?? null;
              return (
                <li
                  key={m.id}
                  className="flex flex-col gap-3 rounded-md border border-border bg-card/40 px-4 py-3"
                >
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex flex-col gap-1">
                      <span className="font-semibold text-foreground">
                        {m.home} vs {m.away}
                      </span>
                      <span className="font-mono text-xs text-slate">
                        {formatLocal(m.kickoffUtc)}
                      </span>
                      {m.round && (
                        <span className="font-mono text-[11px] text-slate">
                          {m.round}
                        </span>
                      )}
                      {!blocked && (
                        <span className="font-mono text-xs text-slate">
                          Kickoff in: {fmtMinutes(minsToKickoff)}
                        </span>
                      )}
                    </div>
                    <span
                      className={`whitespace-nowrap text-sm font-bold ${meta.className}`}
                    >
                      {meta.emoji} {meta.label}
                    </span>
                  </div>

                  <div
                    className={`rounded-md border px-3 py-2 font-mono text-xs font-semibold ${timingBannerClass(
                      band.tone,
                    )}`}
                  >
                    {band.tone === "blocked" ? "🚫 " : ""}
                    {band.label}
                  </div>

                  {blocked ? (
                    <p className="font-mono text-xs text-signal-red">
                      {isMatchBlockedReason(m.statusShort)}
                    </p>
                  ) : (
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => onOpenMatch(m)}
                        className="rounded-md bg-accent-amber px-4 py-2 text-xs font-bold uppercase tracking-wide text-black transition-opacity hover:opacity-90"
                      >
                        Analyse Match ▶
                      </button>
                      {hasResult ? (
                        <span className="font-mono text-[11px] text-signal-green">
                          ✓ Analysed{savedAt ? ` ${formatResultAgo(savedAt, now.getTime())}` : ""}
                        </span>
                      ) : hasState ? (
                        <span className="font-mono text-[11px] text-signal-blue">
                          ✓ calls cached
                        </span>
                      ) : null}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </main>
  );
}

function isMatchBlockedReason(statusShort: string): string {
  const finished = new Set(["FT", "AET", "PEN", "ABD", "AWD", "WO", "CANC"]);
  if (finished.has(statusShort)) return "Match finished — no pre-match bets available.";
  return "Match in progress — no pre-match bets available.";
}

// ─────────────────────────────────────────────────────────────
// MATCH VIEW
// ─────────────────────────────────────────────────────────────
function MatchView({
  match,
  state,
  now,
  retrying,
  analysisMsgIndex,
  analysisElapsedSec,
  onBack,
  onRunCalls,
  onAnalyse,
  onRetry,
  onResumeCalls,
  onResumePoll,
  onClearCache,
  onResetBudget,
  patchState,
}: {
  match: AnalysedMatch;
  state: MatchState;
  now: Date;
  retrying: Set<string>;
  analysisMsgIndex: number;
  analysisElapsedSec: number;
  onBack: () => void;
  onRunCalls: () => void;
  onAnalyse: () => void;
  onRetry: (retryKey: string) => void;
  onResumeCalls: () => void;
  onResumePoll: () => void;
  onClearCache: () => void;
  onResetBudget: () => void;
  patchState: (partial: Partial<MatchState>) => void;
}) {
  const minsToKickoff = minutesUntil(match.kickoffUtc, now);
  const blocked = isMatchBlocked(match.statusShort, minsToKickoff);
  const band = timingBand(minsToKickoff, blocked);

  const panelSummary = state.collection
    ? buildCallPanelSummary(state.collection.callResults)
    : null;
  const callsReady = !!panelSummary && panelSummary.mandatoryReady;
  const running = state.progress !== null;

  // Interrupted-pipeline detection: some calls FAILED while others SUCCEEDED —
  // the pipeline didn't complete cleanly (e.g. tab backgrounded mid-run).
  const failedCount = panelSummary
    ? panelSummary.rows.filter((r) => r.status === "FAILED").length
    : 0;
  const succeededCount = panelSummary
    ? panelSummary.rows.filter((r) => r.status === "SUCCESS" || r.status === "CACHED").length
    : 0;
  const pipelineInterrupted = !running && failedCount > 0 && succeededCount > 0;

  // S3 lineup status for the manual-entry fallback.
  const c6 = state.collection?.callResults["6"];
  const lineupPending = !!state.collection && (!c6 || c6.status !== "SUCCESS");

  return (
    <main className="flex flex-1 flex-col items-center px-6 py-8">
      <div className="flex w-full max-w-5xl flex-col gap-6">
        <button
          type="button"
          onClick={onBack}
          className="self-start text-sm font-semibold text-accent-amber transition-opacity hover:opacity-80"
        >
          ← Fixtures
        </button>

        {/* Match header */}
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-card/40 px-5 py-4">
          <h1 className="text-2xl font-bold text-foreground">
            {match.home} vs {match.away}
          </h1>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-xs text-slate">
            <span>{formatLocal(match.kickoffUtc)}</span>
            {match.round && <span>· {match.round}</span>}
            {!blocked && <span>· Kickoff in {fmtMinutes(minsToKickoff)}</span>}
          </div>
          <div
            className={`mt-1 rounded-md border px-3 py-2 font-mono text-xs font-semibold ${timingBannerClass(
              band.tone,
            )}`}
          >
            {band.tone === "blocked" ? "🚫 " : ""}
            {band.label}
          </div>
        </div>

        {/* SECTION 1 — Data Calls */}
        <section className="flex flex-col gap-3 rounded-lg border border-border bg-background/40 px-5 py-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-bold uppercase tracking-wide text-foreground">
              1 · Data Calls
            </h2>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onRunCalls}
                disabled={running || state.analysing}
                className="rounded-md bg-accent-amber px-4 py-2 text-xs font-bold uppercase tracking-wide text-black transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {running ? "Running calls…" : "Run All Calls"}
              </button>
              <button
                type="button"
                onClick={onResetBudget}
                className="rounded-md border border-accent-amber/60 px-3 py-2 text-[11px] font-semibold text-accent-amber transition-colors hover:bg-accent-amber/10"
              >
                Reset Budget
              </button>
            </div>
          </div>

          {state.lastRunAt && (
            <p className="font-mono text-[11px] text-slate">
              Last run: {new Date(state.lastRunAt).toLocaleTimeString()}
            </p>
          )}

          {running && state.progress && (
            <div className="rounded-md border border-border bg-background/60 px-3 py-3">
              <p className="font-mono text-sm text-accent-amber">
                {state.progress.label}
              </p>
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-border">
                <div
                  className="h-full bg-accent-amber transition-all"
                  style={{
                    width: `${(state.progress.step / state.progress.total) * 100}%`,
                  }}
                />
              </div>
            </div>
          )}

          {state.collectError && (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {state.collectError}
            </div>
          )}

          {panelSummary && (
            <CallStatusPanel
              summary={panelSummary}
              retrying={retrying}
              onRetry={onRetry}
              onClearCache={onClearCache}
            />
          )}

          {pipelineInterrupted && (
            <div className="flex flex-col gap-2 rounded-md border border-signal-red/50 bg-signal-red/10 px-3 py-3">
              <p className="font-mono text-xs font-semibold text-signal-red">
                ⚠️ Pipeline interrupted — {failedCount} call
                {failedCount > 1 ? "s" : ""} incomplete. Tap Resume to continue.
              </p>
              <button
                type="button"
                onClick={onResumeCalls}
                disabled={retrying.size > 0}
                className="self-start rounded-md border border-signal-red bg-signal-red/15 px-4 py-2 text-xs font-bold uppercase tracking-wide text-signal-red transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {retrying.size > 0 ? "Resuming…" : "↻ Resume Calls"}
              </button>
            </div>
          )}



          {lineupPending && (
            <ManualLineupForm
              onSubmit={(home, away) => {
                if (!state.collection) return;
                const injected = {
                  key: "6",
                  label: "Lineups (manual entry)",
                  status: "SUCCESS" as const,
                  data: {
                    source: "manual",
                    home: { starting_xi: home },
                    away: { starting_xi: away },
                  },
                  fetchedAt: Date.now(),
                };
                patchState({
                  collection: {
                    ...state.collection,
                    callResults: {
                      ...state.collection.callResults,
                      "6": injected,
                    },
                    lineupState: "POPULATED",
                    lineupResolved: true,
                  },
                });
                toast.success("Manual lineup saved — re-analyse for full data.");
              }}
            />
          )}

          {!state.collection && !running && (
            <p className="font-mono text-xs text-slate">
              Press “Run All Calls” to fetch API data for this match. Results are
              cached — retry individual calls without re-running the rest.
            </p>
          )}
        </section>

        {/* SECTION 2 — Claude Analysis */}
        {callsReady && (
          <section className="flex flex-col gap-3 rounded-lg border border-border bg-background/40 px-5 py-4">
            <h2 className="text-sm font-bold uppercase tracking-wide text-foreground">
              2 · Claude Analysis
            </h2>

            <button
              type="button"
              onClick={onAnalyse}
              disabled={state.analysing}
              className="self-start rounded-md border border-signal-blue bg-signal-blue/15 px-5 py-2.5 text-xs font-bold uppercase tracking-wide text-signal-blue transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {state.analysing ? "Analysing…" : "🔍 Analyse with Claude ▶"}
            </button>

            {state.analysing && (
              <div className="rounded-md border border-accent-amber/40 bg-accent-amber/5 px-3 py-3">
                <div className="flex items-center gap-3">
                  <span className="h-2 w-2 animate-pulse rounded-full bg-accent-amber" />
                  <p className="font-mono text-sm text-accent-amber">
                    {CLAUDE_LOADING_MESSAGES[analysisMsgIndex]}
                  </p>
                </div>
                <p className="mt-2 font-mono text-xs text-slate">
                  Elapsed: {analysisElapsedSec}s / {formatMaxSeconds(CLAUDE_MAX_SECONDS)} max
                </p>
                <p className="mt-1 font-mono text-[11px] text-slate/80">
                  Runs on the server — safe to switch tabs or lock your phone. The
                  result loads automatically when you return.
                </p>
              </div>
            )}

            {state.pollStalled && (
              <div className="flex flex-col gap-2 rounded-md border border-signal-red/50 bg-signal-red/10 px-3 py-3">
                <p className="font-mono text-xs font-semibold text-signal-red">
                  ⚠️ Lost connection to the analysis. Your job may still be
                  running on the server.
                </p>
                <button
                  type="button"
                  onClick={onResumePoll}
                  className="self-start rounded-md border border-signal-red bg-signal-red/15 px-4 py-2 text-xs font-bold uppercase tracking-wide text-signal-red transition-opacity hover:opacity-90"
                >
                  ↻ Retry
                </button>
              </div>
            )}

            {state.analysisCompletedAway && state.analysisResult !== null && (
              <div className="rounded-md border border-signal-green/50 bg-signal-green/10 px-3 py-2 font-mono text-xs font-semibold text-signal-green">
                ✓ Analysis completed while you were away
              </div>
            )}


            {state.billingError && (
              <div className="rounded-lg border-2 border-signal-red bg-signal-red/15 px-4 py-4 text-signal-red">
                <p className="text-base font-bold">⚠️ Anthropic Billing Issue</p>
                <p className="mt-1 text-sm">
                  Your account credit balance is too low to run analysis. Add
                  credits at{" "}
                  <span className="font-semibold underline">
                    console.anthropic.com
                  </span>{" "}
                  before trying again.
                </p>
              </div>
            )}

            {state.analysisError && (
              <div className="whitespace-pre-wrap rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 font-mono text-xs text-destructive">
                {state.analysisError}
              </div>
            )}
          </section>
        )}

        {/* SECTION 3 — Results */}
        {state.analysing && state.analysisResult === null && !state.analysisRaw && (
          <section className="flex flex-col gap-3 rounded-lg border border-border bg-background/40 px-5 py-4">
            <h2 className="text-sm font-bold uppercase tracking-wide text-foreground">
              3 · Results
            </h2>
            <SkeletonDashboard />
          </section>
        )}

        {(state.analysisResult !== null || state.analysisRaw) && (
          <section className="flex flex-col gap-4 rounded-lg border border-border bg-background/40 px-5 py-4">
            <h2 className="text-sm font-bold uppercase tracking-wide text-foreground">
              3 · Results
            </h2>

            {state.analysisResult !== null ? (
              <>
                <BettingDashboard result={state.analysisResult as AnalysisResult} />
                <ValidationChecksView result={state.analysisResult as AnalysisResult} />
                <div className="rounded-md border border-signal-green/40 bg-signal-green/5 px-4 py-3 font-mono text-xs text-signal-green">
                  ✓ Saved to backtesting log — view it from the Backtest Log tab.
                </div>
              </>
            ) : (
              <div className="flex flex-col gap-2">
                <p className="text-sm font-semibold text-foreground">
                  Claude raw response (unparsed)
                </p>
                <pre className="max-h-96 overflow-auto rounded-md border border-border bg-background/80 p-3 font-mono text-xs text-slate">
                  {state.analysisRaw}
                </pre>
              </div>
            )}

            {state.tokenUsage && (
              <p className="font-mono text-xs text-slate">
                Tokens used:{" "}
                <span className="text-accent-amber">{state.tokenUsage.input}</span>{" "}
                in,{" "}
                <span className="text-accent-amber">{state.tokenUsage.output}</span>{" "}
                out
              </p>
            )}
          </section>
        )}
      </div>
    </main>
  );
}

// Manual lineup entry — shown when TheStatsAPI lineups stay pending. One player
// per line for each side. Injects a synthetic CALL 6 SUCCESS result.
function ManualLineupForm({
  onSubmit,
}: {
  onSubmit: (home: string[], away: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [home, setHome] = useState("");
  const [away, setAway] = useState("");

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="self-start rounded-md border border-accent-amber/50 px-3 py-1.5 text-[11px] font-semibold text-accent-amber transition-colors hover:bg-accent-amber/10"
      >
        Lineups not propagating — enter manually
      </button>
    );
  }

  const parse = (s: string) =>
    s
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean);

  return (
    <div className="flex flex-col gap-3 rounded-md border border-accent-amber/40 bg-accent-amber/5 px-4 py-3">
      <p className="text-xs font-semibold text-accent-amber">
        Manual lineup entry — one player per line
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <label className="text-[11px] text-slate">Home starting XI</label>
          <textarea
            value={home}
            onChange={(e) => setHome(e.target.value)}
            rows={11}
            className="rounded-md border border-border bg-background/80 p-2 font-mono text-xs text-foreground focus:border-accent-amber focus:outline-none"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[11px] text-slate">Away starting XI</label>
          <textarea
            value={away}
            onChange={(e) => setAway(e.target.value)}
            rows={11}
            className="rounded-md border border-border bg-background/80 p-2 font-mono text-xs text-foreground focus:border-accent-amber focus:outline-none"
          />
        </div>
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => {
            onSubmit(parse(home), parse(away));
            setOpen(false);
          }}
          className="rounded-md bg-accent-amber px-4 py-1.5 text-[11px] font-bold uppercase tracking-wide text-black"
        >
          Save Lineups
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-md border border-border px-4 py-1.5 text-[11px] font-semibold text-slate"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function ValidationChecksView({ result }: { result: AnalysisResult }) {
  const mp = result.model_probabilities;
  const ec = result.ensemble_check;
  const dw = result.dimension_weights_validation;

  const recomputed =
    ec &&
    calculateEnsembleAlignment({
      signal_1_model: Number(ec.signal_1_model ?? 0),
      signal_2_poisson: Number(ec.signal_2_poisson ?? 0),
      signal_3_historical: Number(ec.signal_3_historical ?? 0),
    });

  return (
    <details className="rounded-md border border-border bg-background/60" open>
      <summary className="cursor-pointer px-3 py-2 text-sm font-semibold text-foreground">
        Validation Checks
      </summary>
      <div className="space-y-4 border-t border-border px-3 py-3 font-mono text-xs text-slate">
        {/* model_probabilities */}
        <div>
          <div className="mb-1 font-semibold text-foreground">
            model_probabilities
          </div>
          {mp ? (
            <div className="space-y-0.5">
              <div>
                was_normalized:{" "}
                <span className="text-accent-amber">
                  {String(mp.was_normalized ?? false)}
                </span>
              </div>
              <div>
                raw_sum:{" "}
                <span className="text-accent-amber">
                  {typeof mp.raw_sum === "number" ? mp.raw_sum.toFixed(2) : "—"}
                </span>
              </div>
              <div>
                normalized: {Number(mp.home).toFixed(2)} /{" "}
                {Number(mp.draw).toFixed(2)} / {Number(mp.away).toFixed(2)} (sum{" "}
                {(Number(mp.home) + Number(mp.draw) + Number(mp.away)).toFixed(2)})
              </div>
            </div>
          ) : (
            <div className="text-slate">not present in output</div>
          )}
        </div>

        {/* ensemble_check.alignment */}
        <div>
          <div className="mb-1 font-semibold text-foreground">
            ensemble_check.alignment
          </div>
          {ec ? (
            <div className="space-y-0.5">
              <div>
                alignment (stored):{" "}
                <span className="text-accent-amber">{ec.alignment}</span>
              </div>
              <div>
                confidence_impact (stored):{" "}
                <span className="text-accent-amber">{ec.confidence_impact}</span>
              </div>
              <div>
                recomputed alignment:{" "}
                <span className="text-accent-amber">{recomputed?.alignment}</span>{" "}
                | confidence_impact:{" "}
                <span className="text-accent-amber">
                  {recomputed?.confidence_impact}
                </span>{" "}
                | maxDiff:{" "}
                <span className="text-accent-amber">
                  {recomputed?.max_pairwise_diff.toFixed(2)}
                </span>
              </div>
              <div
                className={
                  recomputed &&
                  ec.alignment === recomputed.alignment &&
                  ec.confidence_impact === recomputed.confidence_impact.toString()
                    ? "text-signal-blue"
                    : "text-destructive"
                }
              >
                {recomputed &&
                ec.alignment === recomputed.alignment &&
                ec.confidence_impact === recomputed.confidence_impact.toString()
                  ? "✓ stored matches confidence-math source"
                  : "✗ MISMATCH between stored and recomputed"}
              </div>
            </div>
          ) : (
            <div className="text-slate">not present in output</div>
          )}
        </div>

        {/* dimension_weights_validation */}
        <div>
          <div className="mb-1 font-semibold text-foreground">
            dimension_weights_validation
          </div>
          {dw ? (
            dw.validation_ran === false ? (
              <div className="space-y-1">
                <span className="inline-block rounded bg-destructive/20 px-2 py-0.5 font-semibold text-destructive">
                  NOT RUN — field missing from Claude output
                </span>
                <ul className="list-disc space-y-0.5 pl-5 text-destructive">
                  {dw.mismatch_flags.map((f, i) => (
                    <li key={i}>{f}</li>
                  ))}
                </ul>
              </div>
            ) : dw.mismatch_flags.length === 0 ? (
              <span className="inline-block rounded bg-signal-blue/20 px-2 py-0.5 font-semibold text-signal-blue">
                PASSED — weights match expected conditions
              </span>
            ) : (
              <div className="space-y-1">
                <span className="inline-block rounded bg-accent-amber/20 px-2 py-0.5 font-semibold text-accent-amber">
                  MISMATCH DETECTED
                </span>
                <ul className="list-disc space-y-0.5 pl-5 text-destructive">
                  {dw.mismatch_flags.map((f, i) => (
                    <li key={i}>{f}</li>
                  ))}
                </ul>
              </div>
            )
          ) : (
            <div className="text-slate">not present in output</div>
          )}
        </div>
      </div>
    </details>
  );
}
