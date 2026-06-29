import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  runAnalysis,
  STATUS_META,
  type AnalysedMatch,
} from "@/lib/fixtures";
import {
  collectMatchData,
  type CollectionResult,
  type ProgressUpdate,
} from "@/lib/analyse";
import { getApiCallCount, DAILY_LIMIT, WARNING_THRESHOLD } from "@/lib/apiCounter";

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

function Index() {
  const [now, setNow] = useState(() => new Date());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [matches, setMatches] = useState<AnalysedMatch[] | null>(null);
  const [apiCalls, setApiCalls] = useState(0);

  // Per-match data collection state.
  const [activeMatchId, setActiveMatchId] = useState<number | null>(null);
  const [progress, setProgress] = useState<ProgressUpdate | null>(null);
  const [collection, setCollection] = useState<CollectionResult | null>(null);
  const [collectError, setCollectError] = useState<string | null>(null);

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    setApiCalls(getApiCallCount());
  }, []);

  async function handleRun() {
    setLoading(true);
    setError(null);
    try {
      const result = await runAnalysis();
      setMatches(result.matches);
      setApiCalls(getApiCallCount());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error occurred.");
    } finally {
      setLoading(false);
    }
  }

  async function handleAnalyseMatch(match: AnalysedMatch) {
    setActiveMatchId(match.id);
    setCollection(null);
    setCollectError(null);
    setProgress({ step: 0, total: 11, label: "Building TheStatsAPI lookup…" });
    try {
      const result = await collectMatchData(match, (p) => setProgress(p));
      setCollection(result);
    } catch (e) {
      setCollectError(e instanceof Error ? e.message : "Data collection failed.");
    } finally {
      setProgress(null);
      setApiCalls(getApiCallCount());
    }
  }

  const counterWarning = apiCalls >= WARNING_THRESHOLD;

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="flex items-baseline gap-3 border-b border-border px-6 py-4">
        <span className="text-2xl font-bold tracking-tight text-foreground">EDGE</span>
        <span className="text-sm font-medium text-slate">WC2026 Knockout Intelligence</span>
      </header>

      <main className="flex flex-1 flex-col items-center px-6 py-10">
        <div className="flex w-full max-w-2xl flex-col items-center gap-6">
          <div className="flex flex-col items-center gap-3">
            <button
              type="button"
              onClick={handleRun}
              disabled={loading}
              className="rounded-md bg-accent-amber px-6 py-3 text-sm font-bold uppercase tracking-wide text-black transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? "Analysing…" : "Run Analysis"}
            </button>
            <span className="font-mono text-xs text-slate">
              API calls used today:{" "}
              <span className="text-accent-amber">{apiCalls}</span>/{DAILY_LIMIT}
            </span>
          </div>

          {counterWarning && (
            <div className="w-full rounded-md border border-accent-amber/50 bg-accent-amber/10 px-4 py-3 text-sm text-accent-amber">
              ⚠️ Daily API budget near limit ({apiCalls}/{DAILY_LIMIT}). Predictions
              and bracket calls are skipped for remaining matches today.
            </div>
          )}

          {error && (
            <div className="w-full rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {error}
            </div>
          )}

          {!matches && !error && (
            <p className="pt-10 text-lg font-medium text-slate">
              Run analysis to see today's matches
            </p>
          )}

          {matches && matches.length === 0 && (
            <p className="pt-10 text-lg font-medium text-slate">
              No fixtures found for today or tomorrow.
            </p>
          )}

          {matches && matches.length > 0 && (
            <ul className="flex w-full flex-col gap-3">
              {matches.map((m) => {
                const meta = STATUS_META[m.status];
                const isActive = activeMatchId === m.id;
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
                            disabled={progress !== null}
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
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </main>

      <footer className="border-t border-border px-6 py-3 text-center">
        <span className="font-mono text-sm text-slate" suppressHydrationWarning>
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
