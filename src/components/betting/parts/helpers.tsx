import { cn } from "@/lib/utils";
import { type SgpBet } from "@/lib/analysisResult";

// ─────────────────────────────────────────────────────────────
// Shared constants
// ─────────────────────────────────────────────────────────────
export const CARD = "rounded-xl border border-border bg-background p-6";

// ─────────────────────────────────────────────────────────────
// Classification / data-quality badge styles
// ─────────────────────────────────────────────────────────────
export function classificationStyle(c?: string): {
  label: string;
  className: string;
} {
  const v = (c ?? "").toUpperCase();
  if (v.includes("JACKPOT"))
    return {
      label: c ?? "JACKPOT",
      className: "border-accent-amber/50 bg-accent-amber/15 text-accent-amber",
    };
  if (v.includes("HEAVY"))
    return {
      label: c ?? "HEAVY MISMATCH",
      className: "border-slate-deep/50 bg-slate-deep/15 text-slate-deep",
    };
  if (v.includes("COMPETITIVE"))
    return {
      label: c ?? "COMPETITIVE",
      className: "border-signal-blue/50 bg-signal-blue/15 text-signal-blue",
    };
  return { label: c ?? "—", className: "border-border bg-card text-slate" };
}

export function dataQualityStyle(q?: string): {
  label: string;
  className: string;
} {
  const v = (q ?? "").toUpperCase();
  if (v.includes("FULL"))
    return {
      label: "DATA: FULL",
      className: "border-signal-green/50 bg-signal-green/15 text-signal-green",
    };
  if (v.includes("PARTIAL"))
    return {
      label: "DATA: PARTIAL",
      className: "border-accent-amber/50 bg-accent-amber/15 text-accent-amber",
    };
  if (v.includes("THIN"))
    return {
      label: "DATA: THIN",
      className: "border-signal-red/50 bg-signal-red/15 text-signal-red",
    };
  return { label: "DATA: —", className: "border-border bg-card text-slate" };
}

// ─────────────────────────────────────────────────────────────
// Confidence meter
// ─────────────────────────────────────────────────────────────
export function ConfidenceMeter({ value }: { value?: number }) {
  const v = typeof value === "number" && Number.isFinite(value) ? value : 0;
  const r = 42;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, v));
  const offset = c * (1 - pct / 100);
  const color =
    v >= 68 ? "var(--accent-amber)" : v >= 50 ? "var(--signal-orange)" : "var(--signal-red)";
  return (
    <div className="flex shrink-0 flex-col items-center gap-1">
      <div className="relative h-28 w-28">
        <svg className="h-28 w-28 -rotate-90" viewBox="0 0 100 100">
          <circle
            cx="50"
            cy="50"
            r={r}
            fill="none"
            stroke="var(--color-border)"
            strokeWidth="8"
          />
          <circle
            cx="50"
            cy="50"
            r={r}
            fill="none"
            stroke={color}
            strokeWidth="8"
            strokeLinecap="round"
            strokeDasharray={c}
            strokeDashoffset={offset}
            style={{ transition: "stroke-dashoffset 0.6s ease" }}
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-2xl font-bold text-accent-amber">
            {v ? Math.round(v) : "—"}
          </span>
        </div>
      </div>
      <span className="text-xs text-slate">Confidence</span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Pills
// ─────────────────────────────────────────────────────────────
export function Pill({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function ensemblePill(alignment?: string) {
  const v = (alignment ?? "").toUpperCase();
  if (v.includes("TRIPLE"))
    return {
      text: `TRIPLE ✓✓✓ — ${alignment}`,
      className: "border-signal-green/40 bg-signal-green/15 text-signal-green",
    };
  if (v.includes("MAJORITY"))
    return {
      text: `MAJORITY ✓✓ — ${alignment}`,
      className: "border-signal-blue/40 bg-signal-blue/15 text-signal-blue",
    };
  if (v.includes("CONFLICT"))
    return {
      text: `CONFLICT ✗ — ${alignment}`,
      className: "border-signal-red/40 bg-signal-red/15 text-signal-red",
    };
  return {
    text: `Ensemble: ${alignment ?? "—"}`,
    className: "border-border bg-card text-slate",
  };
}

// ─────────────────────────────────────────────────────────────
// Section label
// ─────────────────────────────────────────────────────────────
export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[11px] font-semibold uppercase tracking-wider text-slate">
      {children}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────
// Formatting helpers
// ─────────────────────────────────────────────────────────────
export function fmtOdds(odds?: number | null): string {
  return typeof odds === "number" && Number.isFinite(odds) ? odds.toFixed(2) : "—";
}

export function sgpCombinedOdds(b?: SgpBet): number | undefined {
  if (typeof b?.combined_odds_sgp === "number" && Number.isFinite(b.combined_odds_sgp))
    return b.combined_odds_sgp;
  const sgp = b?.sgp_validation?.stake_sgp_price;
  if (typeof sgp === "number" && Number.isFinite(sgp)) return sgp;
  const legs = b?.legs ?? [];
  const odds = legs
    .map((l) => l.odds)
    .filter((o): o is number => typeof o === "number" && Number.isFinite(o));
  if (odds.length === 0) return undefined;
  return odds.reduce((acc, o) => acc * o, 1);
}

export function goalsDirectionStyle(dir?: string) {
  const v = (dir ?? "").toUpperCase();
  if (v === "OVER") return "border-signal-green/40 bg-signal-green/15 text-signal-green";
  if (v === "UNDER") return "border-accent-amber/40 bg-accent-amber/15 text-accent-amber";
  return "border-border bg-card text-slate";
}
