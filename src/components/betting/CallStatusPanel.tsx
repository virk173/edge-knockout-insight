import type {
  CallPanelSummary,
  CallPanelRow,
  DisplayStatus,
} from "@/lib/analyse";

interface CallStatusPanelProps {
  summary: CallPanelSummary;
  retrying: Set<string>;
  onRetry: (retryKey: string) => void;
  onClearCache: () => void;
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

function StatusRow({
  row,
  retrying,
  onRetry,
}: {
  row: CallPanelRow;
  retrying: Set<string>;
  onRetry: (retryKey: string) => void;
}) {
  const meta = STATUS_META[row.status];
  const canRetry = row.status === "FAILED" && row.spec.retryKey;
  const isRetrying = row.spec.retryKey ? retrying.has(row.spec.retryKey) : false;
  return (
    <div className="flex items-center justify-between gap-3 py-0.5">
      <span className="flex items-baseline gap-2 truncate">
        <span className="w-9 shrink-0 font-semibold text-slate">{row.spec.id}</span>
        <span className="truncate text-foreground">{row.spec.label}</span>
      </span>
      <span className="flex shrink-0 items-center gap-2">
        {isRetrying ? (
          <span className="text-accent-amber">retrying…</span>
        ) : (
          <span className={`font-semibold ${meta.className}`}>
            {meta.icon} {meta.label}
          </span>
        )}
        {canRetry && !isRetrying && (
          <button
            type="button"
            onClick={() => onRetry(row.spec.retryKey as string)}
            className="rounded border border-signal-red/60 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-signal-red transition-colors hover:bg-signal-red/10"
          >
            Retry
          </button>
        )}
      </span>
    </div>
  );
}

export function CallStatusPanel({
  summary,
  retrying,
  onRetry,
  onClearCache,
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
          <StatusRow key={row.spec.id} row={row} retrying={retrying} onRetry={onRetry} />
        ))}
      </div>

      <div className="flex flex-col gap-1">
        <div className="mb-1 text-[10px] font-bold uppercase tracking-widest text-slate">
          TheStatsAPI
        </div>
        {saRows.map((row) => (
          <StatusRow key={row.spec.id} row={row} retrying={retrying} onRetry={onRetry} />
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
