import { useState } from "react";
import type {
  CallPanelSummary,
  CallPanelRow,
  CallResult,
  DisplayStatus,
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
  const canRetry =
    (row.status === "FAILED" || row.status === "PROPAGATING") && !!retryKey;
  const isRetrying = retryKey ? retrying.has(retryKey) : false;
  const countdown =
    retryKey && propagatingCountdown ? propagatingCountdown[retryKey] : undefined;
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
              onClick={() => onRetry(retryKey as string)}
              className="rounded border border-signal-red/60 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-signal-red transition-colors hover:bg-signal-red/10"
            >
              Retry
            </button>
          )}
        </span>
      </div>
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
  const afRows = summary.rows.filter((r) => r.spec.api === "API-FOOTBALL");
  const saRows = summary.rows.filter((r) => r.spec.api === "THESTATSAPI");

  return (
    <div className="flex w-full flex-col gap-3 rounded-md border border-border bg-background/60 px-4 py-3 font-mono text-xs">
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

function ReadinessBanner({ summary }: { summary: CallPanelSummary }) {
  const counts = `${summary.successCount + summary.cachedCount}/${summary.totalCount} calls successful, ${summary.cachedCount} cached`;

  if (!summary.mandatoryReady) {
    return (
      <div className="rounded-md border border-signal-red/60 bg-signal-red/10 px-3 py-2 text-signal-red">
        <p className="font-bold">❌ Not ready — {summary.notReadyMandatory.join(", ")} failed</p>
        <p className="mt-0.5 text-[11px]">
          Retry {summary.notReadyMandatory.join(", ")} before analysing.
        </p>
      </div>
    );
  }

  if (summary.failedOptional.length > 0) {
    return (
      <div className="rounded-md border border-accent-amber/50 bg-accent-amber/10 px-3 py-2 text-accent-amber">
        <p className="font-bold">⚠️ Ready with reduced data</p>
        <p className="mt-0.5 text-[11px]">
          {summary.failedOptional.join(", ")} failed — confidence will be lower.
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
