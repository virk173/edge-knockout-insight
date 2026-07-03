import { useState } from "react";
import type {
  CallPanelSummary,
  CallPanelRow,
  CallResult,
  DisplayStatus,
  FixtureVerification,
} from "@/lib/analyse";

interface CallStatusPanelProps {
  summary: CallPanelSummary;
  retrying: Set<string>;
  onRetry: (retryKey: string) => void;
  onClearCache: () => void;
  // Optional per-retryKey countdown (seconds until the next auto-retry fires).
  propagatingCountdown?: Record<string, number>;
}

const STATUS_META: Record<
  DisplayStatus,
  { icon: string; label: string; className: string }
> = {
  SUCCESS: { icon: "✅", label: "SUCCESS", className: "text-signal-green" },
  CACHED: { icon: "✅", label: "CACHED", className: "text-signal-blue" },
  EMPTY: { icon: "⚠️", label: "EMPTY", className: "text-accent-amber" },
  PROPAGATING: { icon: "⚠️", label: "PROPAGATING", className: "text-accent-amber" },
  FAILED: { icon: "❌", label: "FAILED", className: "text-signal-red" },
  BLOCKED: { icon: "⛔", label: "BLOCKED", className: "text-signal-red" },
  MISMATCH: { icon: "❌", label: "MISMATCH", className: "text-signal-red" },
  PENDING: { icon: "…", label: "PENDING", className: "text-slate" },
};

// "just now" / "12s ago" / "12m ago" / "3h ago" from an epoch-ms timestamp.
function relativeTime(ts?: number): string {
  if (!ts) return "";
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

function RawResponseBlock({ results }: { results: CallResult[] }) {
  const [open, setOpen] = useState(false);
  if (!results || results.length === 0) return null;
  return (
    <div className="mt-0.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-[10px] text-slate underline underline-offset-2 transition-colors hover:text-foreground"
      >
        {open ? "Hide response ˅" : "View response ›"}
      </button>
      {open && (
        <div className="mt-1 flex flex-col gap-2">
          {results.map((r, i) => (
            <div key={i} className="rounded border border-border bg-background/80 p-2">
              <div className="mb-1 text-[10px] font-semibold text-slate">
                [{r.key}] {r.status}
                {r.error ? ` — ${r.error}` : ""}
              </div>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap font-mono text-[10px] text-slate">
                {JSON.stringify(r.data ?? r.error ?? null, null, 2)}
              </pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Context-aware helper text for EMPTY / PROPAGATING calls, so the retry button
// sets the right expectation about *why* a retry might help (and when).
function retryHint(id: string, status: DisplayStatus): string | null {
  if (status === "PROPAGATING") return "Lineup propagating — retry in 60s";
  if (status !== "EMPTY") return null;
  switch (id) {
    case "C3":
      return "No competitive H2H history between these teams — retry to check again";
    case "C5":
      return "No injuries reported — retry closer to kickoff";
    case "C9A":
      return "Odds not posted yet — retry closer to kickoff (T-80)";
    case "S3":
      return "Lineup not announced — retry after T-75";
    case "C9B":
      return "Pinnacle odds not posted yet — retry closer to kickoff";
    default:
      return "No data found — retry to check again";
  }
}

function StatusRow({
  row,
  retrying,
  onRetry,
  propagatingCountdown,
}: {
  row: CallPanelRow;
  retrying: Set<string>;
  onRetry: (retryKey: string) => void;
  propagatingCountdown?: Record<string, number>;
}) {
  const meta = STATUS_META[row.status];
  const retryKey = row.spec.retryKey;
  const isBlocked = row.status === "BLOCKED";
  // EMPTY is now retryable: a second attempt can productively pick up late data
  // (injuries near kickoff, odds once posted, lineups after T-75). BLOCKED is
  // never individually retryable — the only remedy is retrying C1.
  const canRetry =
    (row.status === "FAILED" ||
      row.status === "PROPAGATING" ||
      row.status === "MISMATCH" ||
      row.status === "EMPTY") &&
    !!retryKey;
  const isRetrying = retryKey ? retrying.has(retryKey) : false;
  const countdown =
    retryKey && propagatingCountdown ? propagatingCountdown[retryKey] : undefined;
  const hint = retryHint(row.spec.id, row.status);
  const isEmpty = row.status === "EMPTY";
  return (
    <div className="flex flex-col gap-0.5 py-0.5">
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-baseline gap-2 truncate">
          <span className="w-9 shrink-0 font-semibold text-slate">{row.spec.id}</span>
          <span className="truncate text-foreground">{row.spec.label}</span>
          {row.fetchedAt && (
            <span className="shrink-0 text-[10px] text-slate">
              · {relativeTime(row.fetchedAt)}
            </span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {isRetrying ? (
            <span className="text-accent-amber">retrying…</span>
          ) : (
            <span className={`font-semibold ${meta.className}`}>
              {meta.icon} {meta.label}
            </span>
          )}
          {row.status === "PROPAGATING" && typeof countdown === "number" && !isRetrying && (
            <span className="text-[10px] text-slate">Retrying in {countdown}s</span>
          )}
          {canRetry && !isRetrying && (
            <button
              type="button"
              title={hint ?? undefined}
              onClick={() => onRetry(retryKey as string)}
              className={
                isEmpty
                  ? "rounded border border-accent-amber/60 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-accent-amber transition-colors hover:bg-accent-amber/10"
                  : "rounded border border-signal-red/60 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-signal-red transition-colors hover:bg-signal-red/10"
              }
            >
              ↻ Retry
            </button>
          )}
        </span>
      </div>
      {isBlocked && (
        <p className="pl-11 text-[10px] text-slate">Blocked — retry C1 first to unblock</p>
      )}
      {hint && !isRetrying && (
        <p className="pl-11 text-[10px] text-slate">{hint}</p>
      )}
      <RawResponseBlock results={row.results} />
    </div>
  );
}

export function CallStatusPanel({
  summary,
  retrying,
  onRetry,
  onClearCache,
  propagatingCountdown,
}: CallStatusPanelProps) {
  const c1Row = summary.rows.find((r) => r.spec.id === "C1");
  const afRows = summary.rows.filter(
    (r) => r.spec.api === "API-FOOTBALL" && r.spec.id !== "C1",
  );
  const saRows = summary.rows.filter((r) => r.spec.api === "THESTATSAPI");

  return (
    <div className="flex w-full flex-col gap-3 rounded-md border border-border bg-background/60 px-4 py-3 font-mono text-xs">
      {c1Row && (
        <FixtureResolution
          row={c1Row}
          retrying={retrying}
          onRetry={onRetry}
        />
      )}

      <div className="flex flex-col gap-1">
        <div className="mb-1 text-[10px] font-bold uppercase tracking-widest text-slate">
          API-Football
        </div>
        {afRows.map((row) => (
          <StatusRow
            key={row.spec.id}
            row={row}
            retrying={retrying}
            onRetry={onRetry}
            propagatingCountdown={propagatingCountdown}
          />
        ))}
      </div>

      <div className="flex flex-col gap-1">
        <div className="mb-1 text-[10px] font-bold uppercase tracking-widest text-slate">
          TheStatsAPI
        </div>
        {saRows.map((row) => (
          <StatusRow
            key={row.spec.id}
            row={row}
            retrying={retrying}
            onRetry={onRetry}
            propagatingCountdown={propagatingCountdown}
          />
        ))}
      </div>

      <ReadinessBanner summary={summary} />

      <button
        type="button"
        onClick={onClearCache}
        className="self-start text-[11px] text-slate underline underline-offset-2 transition-colors hover:text-foreground"
      >
        Clear cache for this match
      </button>
    </div>
  );
}

// FIXTURE RESOLUTION — always shown at the very top so fixture-id resolution is
// visible and auditable on every run rather than silently trusted.
function FixtureResolution({
  row,
  retrying,
  onRetry,
}: {
  row: CallPanelRow;
  retrying: Set<string>;
  onRetry: (retryKey: string) => void;
}) {
  const v = row.results[0]?.data as FixtureVerification | undefined;
  const isRetrying = retrying.has("C1");
  const verified = row.status === "SUCCESS" || row.status === "CACHED";
  const mismatch = row.status === "MISMATCH";
  const inconclusive = row.status === "EMPTY";

  const tone = mismatch
    ? "border-signal-red/60 bg-signal-red/10"
    : inconclusive
      ? "border-accent-amber/50 bg-accent-amber/10"
      : verified
        ? "border-signal-green/50 bg-signal-green/10"
        : "border-border bg-background/60";

  return (
    <div className={`flex flex-col gap-1 rounded-md border px-3 py-2 ${tone}`}>
      <div className="text-[10px] font-bold uppercase tracking-widest text-slate">
        Fixture Resolution
      </div>

      {mismatch ? (
        <div className="text-signal-red">
          <p className="font-bold">
            ⚠️ FIXTURE MISMATCH DETECTED — C1 resolved to the wrong match.
          </p>
          <p className="mt-0.5 text-[11px]">
            Expected: {v?.expectedHome ?? "?"} vs {v?.expectedAway ?? "?"}
          </p>
          <p className="text-[11px]">
            Got: {v?.actualHome ?? "?"} vs {v?.actualAway ?? "?"} · id {v?.fixtureId ?? "?"}
          </p>
          <p className="mt-0.5 text-[11px] text-slate">
            All dependent calls are BLOCKED. Check the fixture lookup and retry.
          </p>
          <button
            type="button"
            disabled={isRetrying}
            onClick={() => onRetry("C1")}
            className="mt-1 rounded border border-signal-red/60 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-signal-red transition-colors hover:bg-signal-red/10 disabled:opacity-50"
          >
            {isRetrying ? "Re-verifying…" : "Retry C1"}
          </button>
        </div>
      ) : verified ? (
        <div className="text-signal-green">
          <p className="font-bold">
            C1 · ✅ VERIFIED {row.status === "CACHED" ? "(cached)" : ""}
          </p>
          <p className="mt-0.5 text-[11px] text-foreground">
            {v?.actualHome ?? v?.expectedHome} vs {v?.actualAway ?? v?.expectedAway} · id{" "}
            {v?.fixtureId}
          </p>
          <p className="text-[11px] text-slate">Teams confirmed ✓</p>
        </div>
      ) : inconclusive ? (
        <div className="text-accent-amber">
          <p className="font-bold">C1 · ⚠️ UNVERIFIED (inconclusive)</p>
          <p className="mt-0.5 text-[11px] text-slate">
            {row.results[0]?.error ?? "Verification response unreadable — proceeding with caveat."}
          </p>
          <button
            type="button"
            disabled={isRetrying}
            onClick={() => onRetry("C1")}
            className="mt-1 rounded border border-accent-amber/50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-accent-amber transition-colors hover:bg-accent-amber/10 disabled:opacity-50"
          >
            {isRetrying ? "Re-verifying…" : "Re-verify C1"}
          </button>
        </div>
      ) : (
        <p className="text-[11px] text-slate">C1 · … verifying fixture id…</p>
      )}
    </div>
  );
}

function ReadinessBanner({ summary }: { summary: CallPanelSummary }) {
  const counts = `${summary.successCount + summary.cachedCount}/${summary.totalCount} calls successful, ${summary.cachedCount} cached`;

  if (!summary.mandatoryReady) {
    return (
      <div className="rounded-md border border-signal-red/60 bg-signal-red/10 px-3 py-2 text-signal-red">
        <p className="font-bold">❌ Not ready — {summary.notReadyMandatory.join(", ")} not ready</p>
        <p className="mt-0.5 text-[11px]">
          Retry {summary.notReadyMandatory.join(", ")} before analysing.
        </p>
      </div>
    );
  }

  const reducedReasons = [...summary.emptyMandatory, ...summary.failedOptional];
  if (reducedReasons.length > 0) {
    return (
      <div className="rounded-md border border-accent-amber/50 bg-accent-amber/10 px-3 py-2 text-accent-amber">
        <p className="font-bold">⚠️ Ready with reduced data</p>
        <p className="mt-0.5 text-[11px]">
          {reducedReasons.join(", ")} returned no data — confidence will be lower.
        </p>
        <p className="mt-0.5 text-[11px] text-slate">[{counts}]</p>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-signal-green/50 bg-signal-green/10 px-3 py-2 text-signal-green">
      <p className="font-bold">✅ Ready to Analyse</p>
      <p className="mt-0.5 text-[11px] text-slate">[{counts}]</p>
    </div>
  );
}
