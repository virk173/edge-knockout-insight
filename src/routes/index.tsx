import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  runAnalysis,
  STATUS_META,
  type AnalysedMatch,
} from "@/lib/fixtures";
import {
  collectMatchData,
  formatDataForClaude,
  resolveDebugFixture,
  buildDebugReport,
  refetchLineups,
  DEBUG_FIXTURE_DATE,
  type CollectionResult,
  type DebugReport,
  type ProgressUpdate,
} from "@/lib/analyse";
import type { AnalysisResult } from "@/lib/analysisResult";
import { calculateResults } from "@/lib/calculate";
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
import { analyseMatch } from "@/lib/analyse-match.functions";
import { BarChart3, HelpCircle } from "lucide-react";

const CLAUDE_LOADING_MESSAGES = [
  "Analysing team form and statistics...",
  "Evaluating tactical matchups...",
  "Calculating expected value...",
  "Checking confirmed lineups...",
  "Building parlay recommendations...",
  "Validating EV thresholds...",
  "Generating betting cards...",
];

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
  return new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

// Lineups for WC2026 are expected to drop ~75 min before kickoff.
const LINEUP_DROP_MIN = 75;

// Minutes from now until kickoff for a fixture (can be negative).
function minutesUntil(iso: string, now: Date): number {
  return Math.round((new Date(iso).getTime() - now.getTime()) / 60000);
}

// "Xh Ym" / "Y min" friendly minutes formatter.
function fmtMinutes(mins: number): string {
  if (mins <= 0) return "now";
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

// Maps a raw pipeline error into a clear, actionable message.
function friendlyError(raw: string): string {
  const m = raw.toLowerCase();
  if (
    m.includes("apifootball_key") ||
    m.includes("vite_apifootball") ||
    m.includes("api key") ||
    m.includes("not configured") ||
    m.includes("missing") && m.includes("key")
  ) {
    return "API key not configured.\nAdd VITE_APIFOOTBALL_KEY to your environment variables.";
  }
  return raw;
}

// Builds a short "next matches" string from the upcoming fixtures.
function nextMatchesText(matches: AnalysedMatch[], now: Date): string {
  const upcoming = matches
    .filter((m) => minutesUntil(m.kickoffUtc, now) > 0)
    .sort(
      (a, b) =>
        new Date(a.kickoffUtc).getTime() - new Date(b.kickoffUtc).getTime(),
    );
  if (upcoming.length === 0) return "None scheduled.";
  return upcoming
    .slice(0, 3)
    .map((m) => `${m.home} vs ${m.away} (${formatLocal(m.kickoffUtc)})`)
    .join(", ");
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



function Index() {
  const [now, setNow] = useState(() => new Date());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [matches, setMatches] = useState<AnalysedMatch[] | null>(null);
  const [apiCalls, setApiCalls] = useState(0);
  const [debugMode, setDebugMode] = useState(false);

  // Top-level view tab.
  const [tab, setTab] = useState<"analysis" | "log">("analysis");
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);



  // Per-match data collection state.
  const [activeMatchId, setActiveMatchId] = useState<number | null>(null);
  const [progress, setProgress] = useState<ProgressUpdate | null>(null);
  const [collection, setCollection] = useState<CollectionResult | null>(null);
  const [collectError, setCollectError] = useState<string | null>(null);

  // Claude analysis state.
  const [analysing, setAnalysing] = useState(false);
  const [analysisMsgIndex, setAnalysisMsgIndex] = useState(0);
  const [analysisResult, setAnalysisResult] = useState<unknown>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [analysisRaw, setAnalysisRaw] = useState<string | null>(null);
  const [tokenUsage, setTokenUsage] = useState<{ input: number; output: number } | null>(null);

  // Debug-mode capture: raw HTTP calls + the formatted Claude input.
  const [formattedDebug, setFormattedDebug] = useState<string | null>(null);

  const callAnalyseMatch = useServerFn(analyseMatch);
  const msgTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  // Tracks fixtures we've already auto-refetched lineups for, so the timer
  // effect only fires one refetch per match once the lineup-drop time passes.
  const lineupRefetchedRef = useRef<Set<number>>(new Set());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    setApiCalls(getApiCallCount());
  }, []);

  useEffect(() => {
    setLogEntries(getLogEntries());
  }, []);

  function handleCycleOutcome(entryId: string, recIndex: number, next: Outcome) {
    setLogEntries(setRecommendationOutcome(entryId, recIndex, next));
  }

  function handleClearLog() {
    setLogEntries(clearLog());
  }

  // Cycle the Claude loading messages every 3 seconds while analysing.
  useEffect(() => {
    if (!analysing) {
      if (msgTimer.current) clearInterval(msgTimer.current);
      msgTimer.current = null;
      return;
    }
    setAnalysisMsgIndex(0);
    msgTimer.current = setInterval(() => {
      setAnalysisMsgIndex((i) => (i + 1) % CLAUDE_LOADING_MESSAGES.length);
    }, 3000);
    return () => {
      if (msgTimer.current) clearInterval(msgTimer.current);
      msgTimer.current = null;
    };
  }, [analysing]);

  // Auto re-fetch CALL 6 (lineups) once the lineup-drop time passes, if the
  // analysis already ran and lineups came back PENDING (empty).
  useEffect(() => {
    if (!collection || activeMatchId == null || !matches) return;
    const match = matches.find((m) => m.id === activeMatchId);
    if (!match) return;
    const c6 = collection.callResults["6"];
    const pending = !c6 || c6.status !== "SUCCESS";
    if (!pending) return;
    const mins = minutesUntil(match.kickoffUtc, now);
    // Lineups drop ~75 min out; only refetch inside that window, pre-kickoff.
    if (mins > LINEUP_DROP_MIN || mins <= 0) return;
    if (lineupRefetchedRef.current.has(match.id)) return;
    lineupRefetchedRef.current.add(match.id);
    (async () => {
      const updated = await refetchLineups(match);
      setCollection((prev) =>
        prev
          ? { ...prev, callResults: { ...prev.callResults, "6": updated } }
          : prev,
      );
      setApiCalls(getApiCallCount());
      if (updated.status === "SUCCESS") {
        toast.success("Confirmed lineups now available — re-analyse for full data.");
      }
    })();
  }, [now, collection, activeMatchId, matches]);

  async function handleRun() {
    if (debugMode) {
      await handleRunDebug();
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await runAnalysis();
      setMatches(result.matches);
      setApiCalls(getApiCallCount());
    } catch (e) {
      setError(friendlyError(e instanceof Error ? e.message : "Unknown error occurred."));
    } finally {
      setLoading(false);
    }
  }

  async function runClaudeAnalysis(
    match: AnalysedMatch,
    result: CollectionResult,
  ) {
    setAnalysing(true);
    setAnalysisResult(null);
    setAnalysisError(null);
    setAnalysisRaw(null);
    setTokenUsage(null);

    let formattedData: string;
    try {
      formattedData = formatDataForClaude(result.callResults);
    } catch (e) {
      console.error("formatDataForClaude failed:", e);
      formattedData = "No usable API data could be formatted for analysis.";
    }
    setFormattedDebug(formattedData);
    const userMessage = `Analyse this World Cup 2026 knockout match using ONLY the injected API data below. Do not use any knowledge from training data for statistics or odds.

MATCH: ${match.home} vs ${match.away}
FIXTURE ID: ${match.id}
ROUND: ${match.round ?? "NOT_AVAILABLE"}
KICKOFF UTC: ${match.kickoffUtc}
CURRENT TIME UTC: ${new Date().toISOString()}
VENUE: ${match.venueName ?? "NOT_AVAILABLE"}
VENUE CITY: ${match.venueCity ?? "NOT_AVAILABLE"}

INJECTED API DATA:

${formattedData}

Generate the complete JSON output exactly as specified in the system prompt.
Return ONLY valid JSON.
No markdown fences.
No explanation outside the JSON.
Start your response with { and end with }.`;

    try {
      const res = await callAnalyseMatch({
        data: { systemPrompt: SYSTEM_PROMPT, userMessage },
      });

      // Guard: the server function can resolve to undefined if the edge
      // request times out or the response cannot be deserialized. Reading
      // `res.ok` directly in that case throws "Cannot read properties of
      // undefined (reading 'ok')".
      if (!res || !res.ok) {
        const msg =
          res?.error ??
          "The analysis service did not return a response. It may have timed out — please try again.";
        setAnalysisError(msg);
        toast.error("Analysis failed", { description: msg });
        return;
      }

      const text: string =
        res.data?.content?.[0]?.text ?? "";



      // Capture token usage for the debug display.
      const usage = res.data?.usage;
      if (usage) {
        setTokenUsage({
          input: usage.input_tokens ?? 0,
          output: usage.output_tokens ?? 0,
        });
      }

      // 1. Strip markdown fences.
      const cleaned = text.replace(/```json|```/g, "").trim();
      setAnalysisRaw(cleaned);

      const tryParse = (): unknown => {
        // First attempt: parse the cleaned text directly.
        try {
          return JSON.parse(cleaned);
        } catch {
          // 2. Fall back to extracting the outermost { ... } block.
          const start = cleaned.indexOf("{");
          const end = cleaned.lastIndexOf("}");
          if (start !== -1 && end !== -1 && end > start) {
            const extracted = cleaned.slice(start, end + 1);
            return JSON.parse(extracted);
          }
          throw new Error("No JSON object found in response.");
        }
      };

      try {
        const parsed = tryParse();
        // Compute all EV / gap / confidence / multiplier / overround figures
        // in application code from Claude's raw *_inputs variables.
        const enriched = calculateResults(parsed);
        setAnalysisResult(enriched);
        toast.success("Analysis complete");

        // Auto-save the log_entry (if present) to the backtesting log.
        const logEntry = enriched?.log_entry;
        if (logEntry && typeof logEntry === "object") {
          const updated = appendLogEntry(logEntry);
          setLogEntries(updated);
          toast.success("Saved to backtesting log");
        }
      } catch {
        // 3. Surface where the response cuts off: first + last 500 chars.
        const head = cleaned.slice(0, 500);
        const tail = cleaned.length > 500 ? cleaned.slice(-500) : "";
        setAnalysisError(
          `Analysis could not be parsed.\nCheck the Debug tab for raw output.\nCommon causes: max_tokens too low, API key invalid, network timeout.\n\n--- FIRST 500 CHARS ---\n${head}\n\n--- LAST 500 CHARS ---\n${tail}`,
        );
        toast.error("Could not parse analysis JSON");
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Claude analysis failed.";
      setAnalysisError(msg);
      toast.error("Analysis failed", { description: msg });
    } finally {
      setAnalysing(false);
    }
  }

  async function handleAnalyseMatch(match: AnalysedMatch) {
    setActiveMatchId(match.id);
    lineupRefetchedRef.current.delete(match.id);
    setCollection(null);
    setCollectError(null);
    setAnalysisResult(null);
    setAnalysisError(null);
    setAnalysisRaw(null);
    setFormattedDebug(null);
    setProgress({ step: 0, total: 11, label: "Starting data collection…" });

    try {
      const result = await collectMatchData(match, (p) => setProgress(p), {
        debug: debugMode,
      });
      setCollection(result);
      setProgress(null);
      setApiCalls(getApiCallCount());
      await runClaudeAnalysis(match, result);
    } catch (e) {
      setCollectError(friendlyError(e instanceof Error ? e.message : "Data collection failed."));
      setProgress(null);
      setApiCalls(getApiCallCount());
    }
  }

  // Debug Mode: run the full pipeline against a fixed real fixture
  // (South Africa vs Canada, June 28) instead of today's timing-gated matches.
  async function handleRunDebug() {
    setLoading(true);
    setError(null);
    setAnalysisResult(null);
    setAnalysisError(null);
    setAnalysisRaw(null);
    setFormattedDebug(null);
    setCollection(null);
    setCollectError(null);
    try {
      const match = await resolveDebugFixture();
      setMatches([match]);
      setActiveMatchId(match.id);
      setProgress({ step: 0, total: 11, label: "Starting data collection…" });
      const result = await collectMatchData(match, (p) => setProgress(p), {
        debug: true,
      });
      setCollection(result);
      setProgress(null);
      setApiCalls(getApiCallCount());
      await runClaudeAnalysis(match, result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error.";
      console.error("Debug run failed:", err);
      setError(`Debug analysis failed: ${friendlyError(msg)}`);
      setProgress(null);
      setApiCalls(getApiCallCount());
    } finally {
      setLoading(false);
    }
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
            onClick={() => setTab("analysis")}
            className={`rounded-md px-3 py-1.5 text-xs font-semibold uppercase tracking-wide transition-colors ${
              tab === "analysis"
                ? "bg-accent-amber text-black"
                : "text-slate hover:text-foreground"
            }`}
          >
            Analysis
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
            Backtesting Log
          </button>
        </nav>

        <div className="flex items-center gap-4">
          <span
            className={`rounded-md border border-border px-2.5 py-1 font-mono text-xs font-semibold ${apiColorClass}`}
            title="API-Football calls used today (resets at midnight UTC)"
          >
            API: {apiCalls}/{DAILY_LIMIT}
          </span>

          <button
            type="button"
            role="switch"
            aria-checked={debugMode}
            aria-label="Toggle Debug Mode"
            onClick={() => setDebugMode((v) => !v)}
            className="flex items-center gap-2"
          >
            <span
              className="text-xs font-semibold uppercase tracking-wide text-slate"
            >
              Debug
            </span>
            <span
              className={`relative inline-block h-6 w-11 rounded-full transition-colors duration-200 ${
                debugMode ? "bg-[#F59E0B]" : "bg-[#334155]"
              }`}
            >
              <span
                className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all duration-200 ${
                  debugMode ? "left-[22px]" : "left-0.5"
                }`}
              />
            </span>
          </button>
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
      ) : (

      <main className="flex flex-1 flex-col items-center px-6 py-10">
        <div className="flex w-full max-w-2xl flex-col items-center gap-6">
          <div className="flex flex-col items-center gap-3">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleRun}
                disabled={loading || analysing}
                className="rounded-md bg-accent-amber px-6 py-3 text-sm font-bold uppercase tracking-wide text-black transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {loading
                  ? "Analysing…"
                  : debugMode
                    ? "Run Debug Analysis"
                    : "Run Analysis"}
              </button>

              {/* How-to-use tooltip (hover on desktop, tap on mobile) */}
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
            <span className="font-mono text-xs text-slate">
              API calls used today:{" "}
              <span className={apiColorClass}>{apiCalls}</span>/{DAILY_LIMIT}
            </span>
          </div>

          {debugMode && (
            <div className="flex w-full flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex-1 rounded-md border border-signal-blue bg-signal-blue/15 px-4 py-3 text-sm font-semibold text-signal-blue">
                REAL API TEST — South Africa vs Canada June 28. Full pipeline
                verification.
              </div>
              <button
                type="button"
                onClick={handleResetBudget}
                className="shrink-0 rounded-md border border-accent-amber/60 px-4 py-2 text-sm font-semibold text-accent-amber transition-colors hover:bg-accent-amber/10 focus:outline-none focus:ring-1 focus:ring-accent-amber"
              >
                Reset API Budget
              </button>
            </div>
          )}


          {counterCritical ? (
            <div className="w-full rounded-md border border-signal-red/60 bg-signal-red/10 px-4 py-3 text-sm font-semibold text-signal-red">
              🚫 API budget critical at {apiCalls}/{DAILY_LIMIT} today. Only
              essential calls running (predictions, referee and bracket calls
              skipped).
            </div>
          ) : counterWarning ? (
            <div className="w-full rounded-md border border-accent-amber/50 bg-accent-amber/10 px-4 py-3 text-sm text-accent-amber">
              ⚠️ API budget at {apiCalls}/{DAILY_LIMIT} today. Skipping
              predictions (C8) and bracket (C10) for remaining matches.
            </div>
          ) : null}

          {error && (
            <div className="w-full whitespace-pre-line rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {error}
            </div>
          )}

          {!matches && !error && (
            <p className="pt-10 text-lg font-medium text-slate">
              Run analysis to see today's matches
            </p>
          )}

          {matches && matches.length === 0 && (
            <div className="w-full rounded-md border border-border bg-card/40 px-4 py-5 text-center text-sm text-slate">
              No World Cup matches scheduled today or tomorrow. Check back closer
              to the next knockout fixtures.
            </div>
          )}

          {matches &&
            matches.length > 0 &&
            matches.filter((m) => !m.isTomorrow).length === 0 && (
              <div className="w-full whitespace-pre-line rounded-md border border-border bg-card/40 px-4 py-4 text-center text-sm text-slate">
                No World Cup matches scheduled today.
                {"\n"}Next match: {nextMatchesText(matches, now)}
              </div>
            )}

          {matches &&
            matches.length > 0 &&
            matches.filter((m) => !m.isTomorrow).length > 0 &&
            matches
              .filter((m) => !m.isTomorrow)
              .every((m) => m.status === "SKIP") && (
              <div className="w-full whitespace-pre-line rounded-md border border-accent-amber/40 bg-accent-amber/5 px-4 py-4 text-center text-sm text-accent-amber">
                All of today's matches have already kicked off. Come back
                tomorrow.
                {"\n"}Next matches: {nextMatchesText(matches, now)}
              </div>
            )}

          {matches && matches.length > 0 && (
            <ul className="flex w-full flex-col gap-3">
              {matches.map((m) => {
                const meta = STATUS_META[m.status];
                const isActive = activeMatchId === m.id;
                const showCountdown =
                  m.status === "OPTIMAL" || m.status === "VALID";
                const minsToKickoff = minutesUntil(m.kickoffUtc, now);
                const minsToLineups = minsToKickoff - LINEUP_DROP_MIN;
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
                        {showCountdown && (
                          <span className="flex flex-wrap gap-x-4 gap-y-0.5 font-mono text-xs">
                            <span className="text-accent-amber">
                              Lineups drop in:{" "}
                              {minsToLineups > 0
                                ? `${fmtMinutes(minsToLineups)} (T-75)`
                                : "confirmed window (T-75)"}
                            </span>
                            <span className="text-slate">
                              Kickoff in: {fmtMinutes(minsToKickoff)}
                            </span>
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-3">
                        <span
                          className={`whitespace-nowrap text-sm font-bold ${meta.className}`}
                        >
                          {meta.emoji} {meta.label}
                        </span>
                        {meta.canAnalyse && (
                          <button
                            type="button"
                            onClick={() => handleAnalyseMatch(m)}
                            disabled={progress !== null || analysing}
                            className="rounded-md border border-accent-amber px-3 py-1.5 text-xs font-semibold text-accent-amber transition-colors hover:bg-accent-amber hover:text-black disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            Analyse this match
                          </button>
                        )}
                      </div>
                    </div>

                    {isActive && progress && (
                      <div className="rounded-md border border-border bg-background/60 px-3 py-3">
                        <p className="font-mono text-sm text-accent-amber">
                          {progress.label}
                        </p>
                        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-border">
                          <div
                            className="h-full bg-accent-amber transition-all"
                            style={{
                              width: `${(progress.step / progress.total) * 100}%`,
                            }}
                          />
                        </div>
                      </div>
                    )}

                    {isActive && collectError && (
                      <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                        {collectError}
                      </div>
                    )}

                    {isActive && collection && (
                      <CollectionPanel result={collection} />
                    )}

                    {isActive && analysing && (
                      <div className="flex items-center gap-3 rounded-md border border-accent-amber/40 bg-accent-amber/5 px-3 py-3">
                        <span className="h-2 w-2 animate-pulse rounded-full bg-accent-amber" />
                        <p className="font-mono text-sm text-accent-amber">
                          {CLAUDE_LOADING_MESSAGES[analysisMsgIndex]}
                        </p>
                      </div>
                    )}

                    {isActive && analysisError && (
                      <div className="whitespace-pre-wrap rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 font-mono text-xs text-destructive">
                        {analysisError}
                      </div>
                    )}

                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Loading skeletons (prevent layout shift while Claude generates) */}
        {activeMatchId !== null &&
          analysing &&
          analysisResult === null &&
          !analysisRaw && (
            <div className="mt-8 w-full max-w-5xl">
              <SkeletonDashboard />
            </div>
          )}

        {/* Wide analysis output area */}
        {activeMatchId !== null && (analysisResult !== null || analysisRaw) && (
          <div className="mt-8 w-full max-w-5xl">
            {analysisResult !== null ? (
              <BettingDashboard result={analysisResult as AnalysisResult} />
            ) : (
              <div className="flex flex-col gap-2">
                <p className="text-sm font-semibold text-foreground">
                  Claude raw response (unparsed)
                </p>
                <pre className="max-h-96 overflow-auto rounded-md border border-border bg-background/80 p-3 font-mono text-xs text-slate">
                  {analysisRaw}
                </pre>
              </div>
            )}
            {tokenUsage && (
              <p className="mt-3 font-mono text-xs text-slate">
                Tokens used:{" "}
                <span className="text-accent-amber">{tokenUsage.input}</span> in,{" "}
                <span className="text-accent-amber">{tokenUsage.output}</span> out
              </p>
            )}
          </div>
        )}

        {/* Debug raw-response inspector */}
        {debugMode &&
          activeMatchId !== null &&
          (collection || formattedDebug || analysisRaw) && (
            <div className="mt-8 flex w-full max-w-5xl flex-col gap-4">
              <div className="flex flex-wrap items-center gap-x-6 gap-y-1 rounded-md border border-signal-blue/40 bg-signal-blue/5 px-4 py-3 font-mono text-xs text-slate">
                <span className="font-semibold text-signal-blue">
                  DEBUG OUTPUT
                </span>
                <span>
                  API calls used:{" "}
                  <span className="text-accent-amber">{apiCalls}</span>/{DAILY_LIMIT}{" "}
                  today
                </span>
                {tokenUsage && (
                  <span>
                    Tokens:{" "}
                    <span className="text-accent-amber">{tokenUsage.input}</span> in{" "}
                    /{" "}
                    <span className="text-accent-amber">{tokenUsage.output}</span>{" "}
                    out
                  </span>
                )}
              </div>



              {collection && (
                <DebugReportView report={buildDebugReport(collection)} />
              )}

              {formattedDebug && (
                <details className="rounded-md border border-border bg-background/60">
                  <summary className="cursor-pointer px-3 py-2 text-sm font-semibold text-foreground">
                    PART 4 — formatDataForClaude output ([CALL N … END CALL N])
                  </summary>
                  <pre className="max-h-96 overflow-auto whitespace-pre-wrap border-t border-border px-3 py-2 font-mono text-xs text-slate">
                    {formattedDebug}
                  </pre>
                </details>
              )}

              {analysisRaw && (
                <details className="rounded-md border border-border bg-background/60" open>
                  <summary className="cursor-pointer px-3 py-2 text-sm font-semibold text-foreground">
                    PART 4 — Final Claude JSON output
                  </summary>
                  <pre className="max-h-96 overflow-auto whitespace-pre-wrap border-t border-border px-3 py-2 font-mono text-xs text-slate">
                    {analysisRaw}
                  </pre>
                </details>
              )}
            </div>
          )}

      </main>
      )}


      <footer className="flex flex-col items-center gap-1 border-t border-border px-6 py-4 text-center">
        <span className="text-xs font-semibold text-foreground">
          Edge v3.2 — WC2026 Knockout Intelligence
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

const STATUS_DOT: Record<string, string> = {
  SUCCESS: "text-accent-amber",
  EMPTY: "text-slate",
  FAILED: "text-destructive",
  SKIPPED: "text-slate",
};

function CollectionPanel({ result }: { result: CollectionResult }) {
  const entries = Object.values(result.callResults);
  return (
    <div className="flex flex-col gap-3 rounded-md border border-border bg-background/60 px-3 py-3">
      <p className="text-sm font-semibold text-foreground">
        Data collection complete:{" "}
        <span className="text-accent-amber">{result.succeeded}</span>/11 calls
        succeeded.{" "}
        <span className="text-slate">
          {result.emptyOrFailed} calls empty or failed.
        </span>
      </p>

      {result.warning && (
        <p className="rounded-md border border-accent-amber/50 bg-accent-amber/10 px-3 py-2 text-xs text-accent-amber">
          {result.warning}
        </p>
      )}

      <ul className="flex flex-col gap-1">
        {entries.map((c) => (
          <li
            key={c.key}
            className="flex items-start justify-between gap-3 font-mono text-xs"
          >
            <span className="text-slate">
              [{c.key}] {c.label.replace(/\s*\(\d+\/11\)/, "")}
            </span>
            <span className={`whitespace-nowrap font-semibold ${STATUS_DOT[c.status]}`}>
              {c.status}
              {c.error ? ` — ${c.error}` : ""}
            </span>
          </li>
        ))}
      </ul>

      {result.failedCalls.length > 0 && (
        <p className="text-xs text-slate">
          Failed/empty calls:{" "}
          <span className="text-destructive">{result.failedCalls.join(", ")}</span>
        </p>
      )}
    </div>
  );
}

function DebugReportView({ report }: { report: DebugReport }) {
  const afRows = report.rows.filter((r) => r.api === "API-Football");
  const saRows = report.rows.filter((r) => r.api === "TheStatsAPI");
  const saSucceeded = report.statsapiSucceeded === report.statsapiTotal;

  return (
    <div className="flex flex-col gap-4">
      <DebugCallGroup title="API-Football calls" rows={afRows} />
      {saRows.length > 0 && (
        <DebugCallGroup
          title="TheStatsAPI calls (S0 lookup, S2A/S2B team stats, S3 lineups, S4 players, S5 Pinnacle)"
          rows={saRows}
        />
      )}

      {/* Summary */}
      <div className="flex flex-col gap-1 rounded-md border border-signal-blue/40 bg-signal-blue/5 px-4 py-3 font-mono text-sm">
        <span className="font-semibold text-signal-blue">SUMMARY</span>
        <span className="text-slate">
          API-Football:{" "}
          <span className="text-accent-amber">
            {report.afSucceeded}/{report.afTotal}
          </span>{" "}
          calls succeeded
          {report.call10ExpectedEmpty && (
            <span className="text-slate">
              {" "}
              (Call 10 empty — expected, next round not yet scheduled)
            </span>
          )}
        </span>


        <span className="text-slate">
          TheStatsAPI:{" "}
          <span className="text-accent-amber">
            {report.statsapiSucceeded}/{report.statsapiTotal}
          </span>{" "}
          calls {saSucceeded ? "succeeded" : "failed"}
        </span>

        <span className="text-slate">
          Ready for Claude:{" "}
          <span
            className={
              report.readyForClaude ? "text-signal-green" : "text-signal-red"
            }
          >
            {report.readyForClaude ? "YES" : "NO"}
          </span>
        </span>
      </div>
    </div>
  );
}


function DebugCallGroup({
  title,
  rows,
}: {
  title: string;
  rows: ReturnType<typeof buildDebugReport>["rows"];
}) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-semibold text-foreground">{title}</p>
      {rows.map((row, i) => (
        <details
          key={i}
          className="rounded-md border border-border bg-background/60"
        >
          <summary className="cursor-pointer px-3 py-2 font-mono text-xs leading-relaxed">
            <span className="font-semibold text-foreground">
              {row.callLabel}
            </span>{" "}
            <span className="text-slate">— {row.api} {row.endpoint}</span>{" "}
            <span className={row.ok ? "text-signal-green" : "text-signal-red"}>
              — Status: {String(row.status)}
            </span>{" "}
            — Data extracted:{" "}
            <span
              className={
                row.dataExtracted ? "text-signal-green" : "text-signal-red"
              }
            >
              {row.dataExtracted ? "YES" : "NO"}
            </span>
            {row.error ? (
              <span className="text-signal-red"> — {row.error}</span>
            ) : null}
          </summary>
          <div className="border-t border-border px-3 py-2">
            <p className="mb-1 break-all font-mono text-[11px] text-slate">
              URL: {row.url}
            </p>
            <pre className="max-h-80 overflow-auto font-mono text-xs text-slate">
              {JSON.stringify(row.json, null, 2)}
            </pre>
          </div>
        </details>
      ))}
    </div>
  );
}
