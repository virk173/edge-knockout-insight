import { useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Lock,
  Info,
  AlertTriangle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  type AnalysisResult,
  type TierLeg,
  formatEv,
  normalizeDimensions,
} from "@/lib/analysisResult";

const CARD =
  "rounded-xl border border-border bg-background p-6";

function classificationStyle(c?: string): { label: string; className: string } {
  const v = (c ?? "").toUpperCase();
  if (v.includes("JACKPOT"))
    return { label: c ?? "JACKPOT", className: "border-accent-amber/50 bg-accent-amber/15 text-accent-amber" };
  if (v.includes("HEAVY"))
    return { label: c ?? "HEAVY MISMATCH", className: "border-slate-deep/50 bg-slate-deep/15 text-slate-deep" };
  if (v.includes("COMPETITIVE"))
    return { label: c ?? "COMPETITIVE", className: "border-signal-blue/50 bg-signal-blue/15 text-signal-blue" };
  return { label: c ?? "—", className: "border-border bg-card text-slate" };
}

// ─────────────────────────────────────────────────────────────
// Confidence meter
// ─────────────────────────────────────────────────────────────
function ConfidenceMeter({ value }: { value?: number }) {
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
// Signal strip pills
// ─────────────────────────────────────────────────────────────
function Pill({
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

function ensemblePill(alignment?: string) {
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

function SignalStrip({ result }: { result: AnalysisResult }) {
  const ens = ensemblePill(result.ensemble_check?.alignment);

  // Best Stake EV across the evaluated tiers (anchor / parlay / jackpot).
  const evs = [
    result.tier_1_anchor?.ev,
    result.tier_2_parlay?.parlay_ev,
    result.tier_3_jackpot?.jackpot_ev,
  ].filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const bestEv = evs.length ? Math.max(...evs) : undefined;
  const evClass =
    bestEv === undefined
      ? "border-border bg-card text-slate"
      : bestEv > 0
        ? "border-signal-green/40 bg-signal-green/15 text-signal-green"
        : "border-signal-red/40 bg-signal-red/15 text-signal-red";

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Pill className={ens.className}>{ens.text}</Pill>
      <Pill className={evClass}>Best Stake EV: {formatEv(bestEv)}</Pill>
    </div>
  );
}



// ─────────────────────────────────────────────────────────────
// Match header
// ─────────────────────────────────────────────────────────────
function MatchHeader({ result }: { result: AnalysisResult }) {
  const cls = classificationStyle(result.classification);
  return (
    <div className={cn(CARD, "flex flex-col gap-4")}>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4">
        <div className="flex min-w-0 flex-col gap-2">
          <h2 className="truncate text-2xl font-bold text-foreground">
            {result.match ?? "Match"}
          </h2>
          <p className="text-sm text-slate">
            {[result.round, result.kickoff_local].filter(Boolean).join(" · ") ||
              "—"}
          </p>
          <span
            className={cn(
              "w-fit rounded-full border px-3 py-1 text-xs font-bold uppercase",
              cls.className,
            )}
          >
            {cls.label}
          </span>
        </div>
        <ConfidenceMeter value={result.confidence_scores?.final_confidence} />
      </div>
      <SignalStrip result={result} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Expandable text (reasoning)
// ─────────────────────────────────────────────────────────────
function ExpandableText({ text }: { text?: string | null }) {
  const [open, setOpen] = useState(false);
  if (!text) return null;
  return (
    <div className="flex flex-col gap-1">
      <p className={cn("text-[13px] leading-relaxed text-slate", !open && "line-clamp-3")}>
        {text}
      </p>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-fit items-center gap-1 text-xs font-medium text-accent-amber"
      >
        {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        {open ? "Show less" : "Show more"}
      </button>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[11px] font-semibold uppercase tracking-wider text-slate">
      {children}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────
// Tier 1 — Anchor
// ─────────────────────────────────────────────────────────────
function Tier1Card({ result }: { result: AnalysisResult }) {
  const t = result.tier_1_anchor;
  if (!t?.active) {
    return (
      <div className={cn(CARD, "flex flex-col items-center gap-3 text-center")}>
        <Lock className="text-slate" size={28} />
        <p className="font-semibold text-slate">No Tier 1 value found</p>
        {t?.skip_reason && (
          <p className="text-[13px] text-slate">{t.skip_reason}</p>
        )}
      </div>
    );
  }

  return (
    <div className={cn(CARD, "flex flex-col gap-4")}>
      <div className="flex items-center gap-2">
        <span className="h-2 w-2 rounded-full bg-signal-green" />
        <SectionLabel>Tier 1 — Anchor Bet</SectionLabel>
      </div>

      <div className="flex flex-col items-center gap-1 py-2 text-center">
        <span className="text-lg font-bold text-foreground">{t.market}</span>
        <span className="text-[22px] font-bold text-accent-amber">
          {t.selection}
        </span>
      </div>

      <div className="grid grid-cols-3 gap-2 text-center">
        <div className="flex flex-col">
          <span className="text-xs text-slate">Odds</span>
          <span className="text-xl font-bold text-foreground">{t.odds ?? "—"}</span>
        </div>
        <div className="flex flex-col">
          <span className="text-xs text-slate">Stake</span>
          <span className="text-xl font-bold text-signal-green">{t.stake ?? "—"}</span>
        </div>
        <div className="flex flex-col">
          <span className="text-xs text-slate">EV</span>
          <span className="text-xl font-bold text-accent-amber">{formatEv(t.ev)}</span>
        </div>
      </div>




      <ExpandableText text={t.reasoning} />

      <a
        href="https://stake.com"
        target="_blank"
        rel="noopener noreferrer"
        className="mt-auto w-full rounded-md bg-accent-amber px-4 py-3 text-center text-sm font-bold uppercase tracking-wide text-black transition-opacity hover:opacity-90"
      >
        Open Stake.com
      </a>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Tier legs (shared by Tier 2 & 3)
// ─────────────────────────────────────────────────────────────
function LegRow({ leg }: { leg: TierLeg }) {
  return (
    <div className="flex items-start gap-3 py-2">
      <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full border border-border text-xs font-bold text-slate">
        {leg.leg_number ?? "•"}
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate font-semibold text-foreground">
            {leg.market}
            {leg.selection ? ` — ${leg.selection}` : ""}
          </span>
          <span className="shrink-0 font-bold text-accent-amber">{leg.odds}</span>
        </div>
        {leg.correlation_logic && (
          <span className="text-xs italic text-slate">{leg.correlation_logic}</span>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Tier 2 — Parlay
// ─────────────────────────────────────────────────────────────
function Tier2Card({ result }: { result: AnalysisResult }) {
  const t = result.tier_2_parlay;
  if (!t?.active) {
    const rebuild = (t?.skip_reason ?? "").toUpperCase().includes("REBUILD");
    return (
      <div className={cn(CARD, "flex flex-col gap-3")}>
        <SectionLabel>Tier 2 — Same Game Parlay</SectionLabel>
        {rebuild && (
          <Pill className="w-fit border-accent-amber/40 bg-accent-amber/15 text-accent-amber">
            Rebuild needed
          </Pill>
        )}
        <p className="text-[13px] text-slate">{t?.skip_reason ?? "Not active."}</p>
      </div>
    );
  }

  const ratio = t.sgp_validation?.sgp_ratio;
  const hold = t.sgp_validation?.hold_rate;
  const ratioClass =
    typeof ratio === "number"
      ? ratio > 0.9
        ? "border-signal-green/40 bg-signal-green/15 text-signal-green"
        : ratio >= 0.8
          ? "border-accent-amber/40 bg-accent-amber/15 text-accent-amber"
          : "border-signal-orange/40 bg-signal-orange/15 text-signal-orange"
      : "border-border bg-card text-slate";

  const evNegative = (t.parlay_ev ?? 0) < 0;

  return (
    <div
      className={cn(
        CARD,
        "flex flex-col gap-4",
        evNegative && "border-signal-red/60",
      )}
    >
      {evNegative && (
        <div className="flex items-center gap-2 rounded-md border border-signal-red/40 bg-signal-red/15 px-3 py-2 text-xs font-bold text-signal-red">
          <AlertTriangle size={14} /> REBUILD REQUIRED
        </div>
      )}

      <SectionLabel>Tier 2 — Same Game Parlay</SectionLabel>

      <Pill className={ratioClass}>
        Hold rate: {typeof hold === "number" ? (hold * 100).toFixed(1) : "—"}% (SGP
        ratio: {ratio ?? "—"})
      </Pill>

      <div className="flex flex-col divide-y divide-border">
        {(t.legs ?? []).map((leg, i) => (
          <LegRow key={i} leg={leg} />
        ))}
        {(t.legs ?? []).length === 0 && (
          <p className="py-2 text-xs text-slate">No legs provided.</p>
        )}
      </div>

      <div className="h-px w-full bg-border" />

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between text-sm">
          <span className="flex items-center gap-1 text-foreground">
            Raw return
            <span title="Based on SGP face odds before hold rate">
              <Info size={12} className="text-slate" />
            </span>
          </span>
          <span className="font-semibold text-foreground">
            {t.returns?.potential_return_raw ?? "—"}
          </span>
        </div>
        <div className="flex items-center justify-between text-sm">
          <span className="flex items-center gap-1 text-foreground">
            Realistic return
            <span title="Hold-adjusted. This is what to expect.">
              <Info size={12} className="text-slate" />
            </span>
          </span>
          <span className="font-bold text-signal-green">
            {t.returns?.potential_return_realistic ?? "—"}
          </span>
        </div>
      </div>

      <Pill
        className={
          evNegative
            ? "w-fit border-signal-red/40 bg-signal-red/15 text-signal-red"
            : "w-fit border-signal-green/40 bg-signal-green/15 text-signal-green"
        }
      >
        EV: {formatEv(t.parlay_ev)}
      </Pill>

      <ExpandableText text={t.reasoning} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Tier 3 — Jackpot
// ─────────────────────────────────────────────────────────────
function Tier3Card({ result }: { result: AnalysisResult }) {
  const t = result.tier_3_jackpot;
  const signals = t?.class_c_signals ?? [];

  if (!t?.active) {
    const met = signals.length;
    return (
      <div className={cn(CARD, "flex flex-col gap-4")}>
        <div className="-m-6 mb-0 rounded-t-xl bg-gradient-to-r from-accent-amber/30 to-accent-amber/5 px-6 py-3">
          <SectionLabel>Tier 3 — Jackpot</SectionLabel>
        </div>
        <p className="font-semibold text-slate">No jackpot today</p>
        <p className="text-xs text-slate">{met} of 3 required signals met:</p>
        <div className="flex flex-wrap gap-2">
          {signals.map((s, i) => (
            <Pill key={i} className="border-border bg-card text-slate">
              {s}
            </Pill>
          ))}
          {signals.length === 0 && (
            <span className="text-xs text-slate">No CLASS C signals present.</span>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={cn(CARD, "flex flex-col gap-4 border-accent-amber")}>
      <div className="-m-6 mb-0 rounded-t-xl bg-gradient-to-r from-accent-amber/40 to-accent-amber/10 px-6 py-3">
        <SectionLabel>Tier 3 — Jackpot</SectionLabel>
      </div>

      <div className="flex flex-col divide-y divide-border">
        {(t.legs ?? []).map((leg, i) => (
          <LegRow key={i} leg={leg} />
        ))}
      </div>

      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col">
          <span className="text-xs text-slate">Combined odds</span>
          <span className="text-2xl font-bold text-accent-amber">
            {t.combined_odds ?? "—"}
          </span>
        </div>
        <div className="flex flex-col">
          <span className="text-xs text-slate">Realistic return</span>
          <span className="text-[28px] font-bold text-signal-green">
            {t.returns?.potential_return_realistic ?? "—"}
          </span>
        </div>
      </div>

      <Pill className="w-fit border-signal-green/40 bg-signal-green/15 text-signal-green">
        EV: {formatEv(t.jackpot_ev)}
      </Pill>

      {signals.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-xs font-bold text-signal-green">⚡ CLASS C SIGNALS:</span>
          <ul className="flex flex-col gap-1">
            {signals.map((s, i) => (
              <li key={i} className="text-[13px] text-signal-green">
                ✓ {s}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Analyst note
// ─────────────────────────────────────────────────────────────
function AnalystNote({ note }: { note?: string }) {
  if (!note) return null;
  return (
    <div className={cn(CARD, "flex flex-col gap-2 border-l-4 border-l-signal-blue")}>
      <SectionLabel>Analyst Note</SectionLabel>
      <p className="text-sm leading-7 text-foreground">{note}</p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// (Market intelligence / Pinnacle card removed — 100% API-Football pipeline)
// ─────────────────────────────────────────────────────────────


// ─────────────────────────────────────────────────────────────
// Analysis details (collapsible)
// ─────────────────────────────────────────────────────────────
function goalsDirectionStyle(dir?: string) {
  const v = (dir ?? "").toUpperCase();
  if (v === "OVER") return "border-signal-green/40 bg-signal-green/15 text-signal-green";
  if (v === "UNDER") return "border-accent-amber/40 bg-accent-amber/15 text-accent-amber";
  return "border-border bg-card text-slate";
}

function AnalysisDetails({ result }: { result: AnalysisResult }) {
  const [open, setOpen] = useState(false);
  const absences = result.player_intelligence?.absences ?? [];
  const tactical = result.tactical_analysis;
  const dims = normalizeDimensions(result.confidence_scores?.dimension_breakdown);
  const adjustments = result.confidence_scores?.adjustments ?? [];
  const evaluated = result.markets_evaluated ?? [];
  const rejected = result.markets_rejected ?? [];

  return (
    <div className={cn(CARD, "flex flex-col gap-4")}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center justify-between gap-2"
      >
        <SectionLabel>View Full Analysis</SectionLabel>
        {open ? (
          <ChevronUp size={16} className="text-slate" />
        ) : (
          <ChevronDown size={16} className="text-slate" />
        )}
      </button>

      {open && (
        <div className="flex flex-col gap-6">
          {/* Player intelligence */}
          {absences.length > 0 && (
            <div className="flex flex-col gap-3">
              <span className="text-xs font-semibold text-slate">
                Player Intelligence
              </span>
              {absences.map((a, i) => (
                <div
                  key={i}
                  className="flex flex-col gap-1 rounded-md border border-border bg-card/40 p-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-foreground">
                      {a.player}{" "}
                      <span className="text-xs font-normal text-slate">
                        {a.team}
                      </span>
                    </span>
                    <span
                      className={cn(
                        "rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase",
                        (a.classification ?? "").toUpperCase() === "CRITICAL"
                          ? "border-signal-red/40 bg-signal-red/15 text-signal-red"
                          : "border-accent-amber/40 bg-accent-amber/15 text-accent-amber",
                      )}
                    >
                      {a.classification}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate">
                    <span>
                      Gap score:{" "}
                      <span className="font-bold text-accent-amber">
                        {a.gap_score}
                      </span>
                    </span>
                    {typeof a.stacked_multiplier === "number" && (
                      <span>Stacked ×{a.stacked_multiplier}</span>
                    )}
                    {a.replacement && (
                      <span>
                        Replacement: {a.replacement}
                        {a.replacement_profile ? ` (${a.replacement_profile})` : ""}
                      </span>
                    )}
                  </div>
                  {a.adjustment_note && (
                    <p className="text-xs text-slate">{a.adjustment_note}</p>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Tactical analysis */}
          {tactical && (
            <div className="flex flex-col gap-2">
              <span className="text-xs font-semibold text-slate">
                Tactical Analysis
              </span>
              <div className="flex flex-wrap items-center gap-2 text-sm text-foreground">
                <span className="rounded-md border border-border bg-card px-2 py-1 text-xs">
                  {tactical.formation_home ?? "—"}
                </span>
                <span className="text-slate">vs</span>
                <span className="rounded-md border border-border bg-card px-2 py-1 text-xs">
                  {tactical.formation_away ?? "—"}
                </span>
                {tactical.goals_model_direction && (
                  <span
                    className={cn(
                      "rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase",
                      goalsDirectionStyle(tactical.goals_model_direction),
                    )}
                  >
                    {tactical.goals_model_direction}
                  </span>
                )}
              </div>
              {tactical.press_matchup_type && (
                <p className="text-xs text-slate">{tactical.press_matchup_type}</p>
              )}
            </div>
          )}

          {/* Confidence breakdown */}
          {(dims.length > 0 || adjustments.length > 0) && (
            <div className="flex flex-col gap-2">
              <span className="text-xs font-semibold text-slate">
                Confidence Breakdown
              </span>
              {dims.map((d, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between gap-2 text-xs"
                >
                  <span className="text-slate">{d.label ?? d.dimension}</span>
                  <span className="text-foreground">
                    {typeof d.weight === "number" ? `w${d.weight} · ` : ""}
                    <span className="font-semibold text-accent-amber">{d.score}</span>
                  </span>
                </div>
              ))}
              {typeof result.confidence_scores?.dimension_weighted_raw === "number" && (
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="text-slate">Weighted raw</span>
                  <span className="font-semibold text-foreground">
                    {result.confidence_scores.dimension_weighted_raw}
                  </span>
                </div>
              )}
              {adjustments.map((adj, i) => (
                <div
                  key={`adj-${i}`}
                  className="flex items-center justify-between gap-2 text-xs"
                >
                  <span className="text-slate">{adj.type}</span>
                  <span
                    className={cn(
                      "font-semibold",
                      (adj.delta ?? 0) >= 0 ? "text-signal-green" : "text-signal-red",
                    )}
                  >
                    {(adj.delta ?? 0) >= 0 ? "+" : ""}
                    {adj.delta}
                  </span>
                </div>
              ))}
              {typeof result.confidence_scores?.final_confidence === "number" && (
                <div className="mt-1 flex items-center justify-between gap-2 border-t border-border pt-2 text-xs">
                  <span className="font-semibold text-foreground">
                    Final confidence
                  </span>
                  <span className="font-bold text-accent-amber">
                    {result.confidence_scores.final_confidence}
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Markets evaluated / rejected */}
          {(evaluated.length > 0 || rejected.length > 0) && (
            <div className="flex flex-col gap-3">
              <span className="text-xs font-semibold text-slate">
                Markets Evaluated &amp; Rejected
              </span>
              {evaluated.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {evaluated.map((m, i) => (
                    <Pill
                      key={i}
                      className="border-signal-green/40 bg-signal-green/15 text-signal-green"
                    >
                      {m}
                    </Pill>
                  ))}
                </div>
              )}
              {rejected.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {rejected.map((m, i) => (
                    <span
                      key={i}
                      title={`EV ${formatEv(m.ev)} — ${m.reason ?? ""}`}
                      className="inline-flex cursor-help items-center gap-1.5 rounded-full border border-signal-red/40 bg-signal-red/15 px-3 py-1.5 text-xs font-semibold text-signal-red"
                    >
                      {m.market}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Bottom bar
// ─────────────────────────────────────────────────────────────
function BottomBar({ result }: { result: AnalysisResult }) {
  const [riskOpen, setRiskOpen] = useState(false);
  const hasUnallocated =
    !!result.unallocated_stake &&
    !/^\$?0(\.0+)?$/.test(result.unallocated_stake.trim());

  return (
    <div className="sticky bottom-0 z-10 flex flex-col gap-2 rounded-xl border border-border bg-background/95 px-5 py-3 backdrop-blur">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
        <span className="text-slate">
          Total staked:{" "}
          <span className="font-bold text-foreground">
            {result.total_staked ?? "—"}
          </span>
        </span>
        {hasUnallocated && (
          <span className="text-slate">
            Unallocated:{" "}
            <span className="font-bold text-accent-amber">
              {result.unallocated_stake}
            </span>
          </span>
        )}
      </div>
      {result.key_risk_flag && (
        <button
          type="button"
          onClick={() => setRiskOpen((o) => !o)}
          className="flex items-start gap-1.5 text-left text-xs text-slate"
        >
          <AlertTriangle size={13} className="mt-0.5 shrink-0 text-accent-amber" />
          <span className={cn(!riskOpen && "line-clamp-1")}>
            Key risk: {result.key_risk_flag}
          </span>
        </button>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Dashboard
// ─────────────────────────────────────────────────────────────
export function BettingDashboard({ result }: { result: AnalysisResult }) {
  return (
    <div className="flex flex-col gap-4">
      <MatchHeader result={result} />

      <div className="grid gap-4 md:grid-cols-2">
        <Tier1Card result={result} />
        <Tier2Card result={result} />
      </div>

      <Tier3Card result={result} />

      <AnalystNote note={result.analyst_note} />



      <AnalysisDetails result={result} />

      <BottomBar result={result} />
    </div>
  );
}
