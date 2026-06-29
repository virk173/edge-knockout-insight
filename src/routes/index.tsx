import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  runAnalysis,
  STATUS_META,
  type AnalysedMatch,
} from "@/lib/fixtures";

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

const CALL_COUNT_KEY = "edge_api_calls";

function readTodayCalls(): number {
  if (typeof window === "undefined") return 0;
  try {
    const raw = window.localStorage.getItem(CALL_COUNT_KEY);
    if (!raw) return 0;
    const parsed = JSON.parse(raw) as { date: string; count: number };
    const today = new Date().toISOString().slice(0, 10);
    return parsed.date === today ? parsed.count : 0;
  } catch {
    return 0;
  }
}

function writeTodayCalls(count: number) {
  if (typeof window === "undefined") return;
  const today = new Date().toISOString().slice(0, 10);
  window.localStorage.setItem(
    CALL_COUNT_KEY,
    JSON.stringify({ date: today, count }),
  );
}

function Index() {
  const [now, setNow] = useState(() => new Date());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [matches, setMatches] = useState<AnalysedMatch[] | null>(null);
  const [apiCalls, setApiCalls] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    setApiCalls(readTodayCalls());
  }, []);

  async function handleRun() {
    setLoading(true);
    setError(null);
    try {
      const result = await runAnalysis();
      setMatches(result.matches);
      const updated = readTodayCalls() + result.apiCallsUsed;
      writeTodayCalls(updated);
      setApiCalls(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error occurred.");
    } finally {
      setLoading(false);
    }
  }

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
              <span className="text-accent-amber">{apiCalls}</span>/100
            </span>
          </div>

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
                return (
                  <li
                    key={m.id}
                    className="flex flex-col gap-2 rounded-md border border-border bg-card/40 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
                  >
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
                          className="rounded-md border border-accent-amber px-3 py-1.5 text-xs font-semibold text-accent-amber transition-colors hover:bg-accent-amber hover:text-black"
                        >
                          Analyse this match
                        </button>
                      )}
                    </div>
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
