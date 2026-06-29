import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

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

function Index() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="flex items-baseline gap-3 border-b border-border px-6 py-4">
        <span className="text-2xl font-bold tracking-tight text-foreground">EDGE</span>
        <span className="text-sm font-medium text-slate">WC2026 Knockout Intelligence</span>
      </header>

      <main className="flex flex-1 items-center justify-center px-6">
        <p className="text-lg font-medium text-slate">
          Run analysis to see today's matches
        </p>
      </main>

      <footer className="border-t border-border px-6 py-3 text-center">
        <span className="font-mono text-sm text-slate" suppressHydrationWarning>
          {formatUtc(now)}
        </span>
      </footer>
    </div>
  );
}
