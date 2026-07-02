import { useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Info,
  AlertTriangle,
  MapPin,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { formatMatchTime } from "@/lib/formatMatchTime";
import {
  type AnalysisResult,
  type StraightBet,
  type SgpBet,
  type JackpotBet,
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

function dataQualityStyle(q?: string): { label: string; className: string } {
  const v = (q ?? "").toUpperCase();
  if (v.includes("FULL"))
    return { label: "DATA: FULL", className: "border-signal-green/50 bg-signal-green/15 text-signal-green" };
  if (v.includes("PARTIAL"))
    return { label: "DATA: PARTIAL", className: "border-accent-amber/50 bg-accent-amber/15 text-accent-amber" };
  if (v.includes("THIN"))
    return { label: "DATA: THIN", className: "border-signal-red/50 bg-signal-red/15 text-signal-red" };
  return { label: "DATA: —", className: "border-border bg-card text-slate" };
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

  // Best Stake EV across the four bets.
  const evs = [
    result.bet_1?.ev,
    result.bet_2?.ev,
    result.bet_3?.parlay_ev,
    result.bet_4?.jackpot_ev,
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
  const dq = dataQualityStyle(result.data_quality);
  return (
    <div className={cn(CARD, "flex flex-col gap-4")}>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4">
        <div className="flex min-w-0 flex-col gap-2">
          <h2 className="truncate text-2xl font-bold text-foreground">
            {result.match ?? "Match"}
          </h2>
          <p className="text-sm text-slate">
            {[result.round, formatMatchTime(result.kickoff_UTC) ?? result.kickoff_local]
              .filter(Boolean)
              .join(" · ") || "—"}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cn(
                "w-fit rounded-full border px-3 py-1 text-xs font-bold uppercase",
                cls.className,
              )}
            >
              {cls.label}
            </span>
            <span
              className={cn(
                "w-fit rounded-full border px-3 py-1 text-xs font-bold uppercase",
                dq.className,
              )}
              title="Data quality of the API inputs used for this analysis"
            >
              {dq.label}
            </span>
          </div>
          <ContextFlags result={result} />
        </div>
        <ConfidenceMeter value={result.confidence_scores?.final_confidence} />
      </div>
      <SignalStrip result={result} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Context flags — altitude / rest / travel (only when relevant)
// ─────────────────────────────────────────────────────────────
function ContextFlags({ result }: { result: AnalysisResult }) {
  const flags: { key: string; label: string }[] = [];

  const alt = result.altitude_adjustment;
  if (alt?.applies_to) {
    flags.push({
      key: "altitude",
      label: `⛰️ Altitude: ${alt.applies_to} disadvantaged`,
    });
  }

  const rest = result.rest_disparity;
  if (rest?.fatigued_team) {
    flags.push({
      key: "rest",
      label: `😴 Rest: ${rest.fatigued_team} -${Math.round(
        rest.disparity_hours,
      )}h`,
    });
  }

  const travel = result.travel_burden;
  if (travel?.burdened_team) {
    const shift = Math.max(
      travel.home_timezone_shift,
      travel.away_timezone_shift,
    );
    flags.push({
      key: "travel",
      label: `✈️ Travel: ${travel.burdened_team} ${shift}tz`,
    });
  }

  if (flags.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {flags.map((f) => (
        <span
          key={f.key}
          className="w-fit rounded-full border border-accent-amber/40 bg-accent-amber/10 px-3 py-1 text-xs font-semibold text-accent-amber"
        >
          {f.label}
        </span>
      ))}
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
// Formatting helpers
// ─────────────────────────────────────────────────────────────
function fmtOdds(odds?: number | null): string {
  return typeof odds === "number" && Number.isFinite(odds) ? odds.toFixed(2) : "—";
}

function evPctText(ev?: number): string {
  if (typeof ev !== "number" || !Number.isFinite(ev)) return "—";
  return `${ev >= 0 ? "+" : ""}${(ev * 100).toFixed(1)}%`;
}

function evTextClass(ev?: number): string {
  if (typeof ev !== "number" || !Number.isFinite(ev)) return "text-slate";
  if (ev < 0) return "text-signal-red";
  if (ev < 0.05) return "text-signal-red";
  if (ev < 0.08) return "text-accent-amber";
  return "text-signal-green";
}

function kellyText(bet: StraightBet): string | null {
  const k = bet.kelly_result;
  if (!k) return null;
  const bankroll =
    typeof bet.kelly_inputs?.bankroll === "number" ? bet.kelly_inputs.bankroll : 50;
  return `Kelly: ${k.fractional_kelly_pct}% of $${bankroll}`;
}

function sgpCombinedOdds(b?: SgpBet): number | undefined {
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

// ─────────────────────────────────────────────────────────────
// Navigation label (Stake.com path)
// ─────────────────────────────────────────────────────────────
function NavLabel({ label }: { label?: string }) {
  if (!label) return null;
  return (
    <div className="mt-1 flex items-start gap-1.5 rounded-md border border-border bg-card/40 px-3 py-2 text-[12px] leading-relaxed text-slate">
      <MapPin size={13} className="mt-0.5 shrink-0 text-accent-amber" />
      <span className="whitespace-pre-line">{label}</span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Individual bet rows for the unified "Your Bets" card
// ─────────────────────────────────────────────────────────────
function StraightBetRow({
  index,
  bet,
}: {
  index: number;
  bet?: StraightBet;
}) {
  if (!bet?.active) {
    return (
      <div className="flex flex-col gap-1 border-t border-border pt-4 first:border-t-0 first:pt-0">
        <span className="font-bold text-slate">
          ❌ BET {index} — Straight Bet
        </span>
        <span className="text-[13px] text-slate">
          {bet?.skip_reason || "Inactive — no qualifying value."}
        </span>
      </div>
    );
  }

  const kelly = kellyText(bet);
  return (
    <div className="flex flex-col gap-1 border-t border-border pt-4 first:border-t-0 first:pt-0">
      <span className="font-bold text-signal-green">
        ✅ BET {index} — Straight Bet
      </span>
      <span className="text-base font-semibold text-foreground">
        {bet.market ?? "—"}: <span className="text-accent-amber">{bet.selection ?? "—"}</span>
      </span>
      <span className="text-sm text-slate">
        Odds: <span className="font-bold text-foreground">{fmtOdds(bet.odds)}</span>
        {" | "}
        Stake: <span className="font-bold text-signal-green">{bet.stake ?? "—"}</span>
      </span>
      <span className="text-sm text-slate">
        EV: <span className={cn("font-bold", evTextClass(bet.ev))}>{evPctText(bet.ev)}</span>
        {kelly ? <> {" | "}{kelly}</> : null}
        {bet.ev_confidence ? (
          <span className="text-slate"> ({bet.ev_confidence} confidence)</span>
        ) : null}
      </span>
      <NavLabel label={bet.stake_label} />
      <ExpandableText text={bet.reasoning} />
    </div>
  );
}

function SgpBetRow({ bet }: { bet?: SgpBet }) {
  if (!bet?.active) {
    return (
      <div className="flex flex-col gap-1 border-t border-border pt-4">
        <span className="font-bold text-slate">
          ❌ BET 3 — 3-Leg Accumulator
        </span>
        <span className="text-[13px] text-slate">
          {bet?.skip_reason || "Inactive — SGP not viable."}
        </span>
      </div>
    );
  }

  const legs = bet.legs ?? [];
  const odds = sgpCombinedOdds(bet);
  const ret = bet.returns?.potential_return_realistic;
  return (
    <div className="flex flex-col gap-1 border-t border-border pt-4">
      <span className="font-bold text-signal-green">
        ✅ BET 3 — 3-Leg Accumulator
      </span>
      <span className="text-base font-semibold text-foreground">
        Same Game Parlay @{" "}
        <span className="text-accent-amber">{fmtOdds(odds)}</span>
      </span>
      <ul className="flex flex-col gap-0.5 py-1">
        {legs.map((leg, i) => (
          <li key={i} className="text-sm text-slate">
            • {leg.market ?? "—"}: {leg.selection ?? "—"}
            {typeof leg.odds === "number" ? (
              <span className="text-slate"> @ {fmtOdds(leg.odds)}</span>
            ) : null}
          </li>
        ))}
        {legs.length === 0 && (
          <li className="text-sm text-slate">No legs provided.</li>
        )}
      </ul>
      <span className="text-sm text-slate">
        Stake: <span className="font-bold text-signal-green">{bet.stake ?? "$10"}</span>
        {ret ? (
          <>
            {" | "}
            Return: <span className="font-bold text-signal-green">~{ret}</span>
          </>
        ) : null}
        {" | "}
        EV: <span className={cn("font-bold", evTextClass(bet.parlay_ev))}>{evPctText(bet.parlay_ev)}</span>
      </span>
      <NavLabel
        label={
          bet.legs?.[0]?.stake_label
            ? "Soccer → Same Game Parlay\nAdd all legs above"
            : undefined
        }
      />
      <ExpandableText text={bet.reasoning} />
    </div>
  );
}

function JackpotBetRow({ bet }: { bet?: JackpotBet }) {
  if (!bet?.active) {
    const met = bet?.class_c_signals?.length ?? 0;
    return (
      <div className="flex flex-col gap-1 border-t border-border pt-4">
        <span className="font-bold text-slate">❌ BET 4 — Jackpot</span>
        <span className="text-[13px] text-slate">
          {bet?.skip_reason ||
            (met > 0
              ? `${met} of 3 CLASS C signals — jackpot not triggered.`
              : "No CLASS C signals this match.")}
        </span>
      </div>
    );
  }

  const legs = bet.legs ?? [];
  const ret = bet.returns?.potential_return_realistic;
  return (
    <div className="flex flex-col gap-1 border-t border-border pt-4">
      <span className="font-bold text-signal-green">✅ BET 4 — Jackpot</span>
      <span className="text-base font-semibold text-foreground">
        Accumulator @{" "}
        <span className="text-accent-amber">{fmtOdds(bet.combined_odds)}</span>
      </span>
      <ul className="flex flex-col gap-0.5 py-1">
        {legs.map((leg, i) => (
          <li key={i} className="text-sm text-slate">
            • {leg.market ?? "—"}: {leg.selection ?? "—"}
            {typeof leg.odds === "number" ? (
              <span className="text-slate"> @ {fmtOdds(leg.odds)}</span>
            ) : null}
          </li>
        ))}
      </ul>
      <span className="text-sm text-slate">
        Stake: <span className="font-bold text-signal-green">{bet.stake ?? "$10"}</span>
        {ret ? (
          <>
            {" | "}
            Return: <span className="font-bold text-signal-green">~{ret}</span>
          </>
        ) : null}
      </span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Unified "Your Bets" card (replaces the three tier cards)
// ─────────────────────────────────────────────────────────────
function YourBets({ result }: { result: AnalysisResult }) {
  const dq = (result.data_quality ?? "").toUpperCase();
  const showDqWarning = dq.includes("PARTIAL") || dq.includes("THIN");
  const subtitle =
    [result.match, result.round].filter(Boolean).join(" — ") || "—";

  const hasUnallocated =
    !!result.unallocated_stake &&
    !/^\$?0(\.0+)?$/.test(result.unallocated_stake.trim());

  return (
    <div className={cn(CARD, "flex flex-col gap-4")}>
      <div className="flex flex-col gap-1">
        <h2 className="text-xl font-bold text-foreground">🎯 Your Bets</h2>
        <p className="text-sm text-slate">{subtitle}</p>
        {showDqWarning && (
          <p className="text-xs font-semibold text-accent-amber">
            ⚠️ Data quality: {dq.includes("THIN") ? "THIN" : "PARTIAL"}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-4">
        <StraightBetRow index={1} bet={result.bet_1} />
        <StraightBetRow index={2} bet={result.bet_2} />
        <SgpBetRow bet={result.bet_3} />
        <JackpotBetRow bet={result.bet_4} />
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border pt-3 text-sm">
        <span className="text-slate">
          Total Staked:{" "}
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
// Top Bets — simple plain-language summary (above the detail card)
// ─────────────────────────────────────────────────────────────
type EvLabel = { text: string; className: string };

function evRatingLabel(rating?: string, numericEv?: number): EvLabel {
  const v = (rating ?? "").toUpperCase();
  // Numeric EV is authoritative when present — it cannot disagree with the
  // computed value the way a stale Claude-supplied label can.
  if (typeof numericEv === "number" && Number.isFinite(numericEv)) {
    if (numericEv < 0) return { text: "NEGATIVE", className: "text-signal-red" };
    if (numericEv < 0.05) return { text: "SKIP", className: "text-signal-red" };
    if (numericEv < 0.08)
      return { text: "MARGINAL", className: "text-accent-amber" };
    return { text: "STRONG", className: "text-signal-green" };
  }
  if (v.includes("STRONG"))
    return { text: "STRONG", className: "text-signal-green" };
  if (v.includes("MARGINAL"))
    return { text: "MARGINAL", className: "text-accent-amber" };
  if (v.includes("NEGATIVE") || v.includes("SKIP"))
    return { text: v, className: "text-signal-red" };
  if (v) return { text: v, className: "text-accent-amber" };
  return { text: "—", className: "text-slate" };
}

interface TopBetRow {
  key: string;
  label: string;
  selection: string;
  odds: number | undefined;
  stake?: string;
  ev: EvLabel;
  confidence?: "HIGH" | "MEDIUM" | "LOW";
}

function TopBetItem({ index, row }: { index: number; row: TopBetRow }) {
  return (
    <li className="flex gap-3">
      <span className="text-base font-bold text-slate">{index}.</span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="font-bold text-foreground">
          {row.label} — <span className="text-foreground">{row.selection}</span>
        </span>
        <span className="text-sm text-slate">
          Odds: <span className="font-bold text-accent-amber">{fmtOdds(row.odds)}</span>
          {row.stake ? (
            <>
              {" "}
              | Stake: <span className="font-bold text-accent-amber">{row.stake}</span>
            </>
          ) : null}
        </span>
        <span className="text-sm text-slate">
          EV: <span className={cn("font-bold", row.ev.className)}>{row.ev.text}</span>
          {row.confidence ? (
            <span className="text-slate"> ({row.confidence} confidence)</span>
          ) : null}
        </span>
      </div>
    </li>
  );
}

function TopBets({ result }: { result: AnalysisResult }) {
  const b1 = result.bet_1;
  const b2 = result.bet_2;
  const b3 = result.bet_3;
  const b4 = result.bet_4;

  const rows: TopBetRow[] = [];

  if (b1?.active) {
    rows.push({
      key: "bet1",
      label: "BET 1",
      selection: b1.selection ?? b1.market ?? "—",
      odds: b1.odds,
      stake: b1.stake,
      ev: evRatingLabel(b1.ev_rating, b1.ev),
      confidence: b1.ev_confidence,
    });
  }

  if (b2?.active) {
    rows.push({
      key: "bet2",
      label: "BET 2",
      selection: b2.selection ?? b2.market ?? "—",
      odds: b2.odds,
      stake: b2.stake,
      ev: evRatingLabel(b2.ev_rating, b2.ev),
      confidence: b2.ev_confidence,
    });
  }

  if (b3?.active) {
    const legs = b3.legs ?? [];
    const sel = legs
      .map((l: TierLeg) => l.selection || l.market)
      .filter(Boolean)
      .join(" + ");
    rows.push({
      key: "bet3",
      label: `BET 3 — ${legs.length}-leg SGP`,
      selection: sel || "Same Game Parlay",
      odds: sgpCombinedOdds(b3),
      stake: b3.stake,
      ev: evRatingLabel(b3.ev_rating, b3.parlay_ev),
    });
  }

  if (b4?.active) {
    const legs = b4.legs ?? [];
    rows.push({
      key: "bet4",
      label: `BET 4 — ${legs.length}-leg jackpot`,
      selection: "JACKPOT",
      odds: b4.combined_odds,
      stake: b4.stake,
      ev: evRatingLabel(undefined, b4.jackpot_ev),
    });
  }

  const noneActive = rows.length === 0;
  const dq = (result.data_quality ?? "").toUpperCase();
  const showDqWarning = dq.includes("PARTIAL") || dq.includes("THIN");
  const subtitle =
    [result.match, result.round, formatMatchTime(result.kickoff_UTC)]
      .filter(Boolean)
      .join(" — ") || "—";

  return (
    <div className={cn(CARD, "flex flex-col gap-4 border-accent-amber/40")}>
      <div className="flex flex-col gap-1">
        <h2 className="text-xl font-bold text-foreground">Top Bets</h2>
        <p className="text-sm text-slate">{subtitle}</p>
        {showDqWarning && (
          <p className="text-xs font-semibold text-accent-amber">
            ⚠️ Data quality: {dq.includes("THIN") ? "THIN" : "PARTIAL"} — some inputs
            missing, treat with extra caution
          </p>
        )}
      </div>

      {noneActive ? (
        <p className="text-sm text-slate">
          No qualifying bets this match.{" "}
          <span className="font-semibold text-accent-amber">
            {result.unallocated_stake ?? "$50"} unallocated
          </span>
          {b1?.skip_reason ? ` — ${b1.skip_reason}` : ""}
        </p>
      ) : (
        <>
          <ol className="flex flex-col gap-3">
            {rows.map((row, i) => (
              <TopBetItem key={row.key} index={i + 1} row={row} />
            ))}
          </ol>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border pt-3 text-xs text-slate">
            <span>
              Total staked:{" "}
              <span className="font-bold text-foreground">
                {result.total_staked ?? "—"}
              </span>
            </span>
            {result.unallocated_stake &&
              !/^\$?0(\.0+)?$/.test(result.unallocated_stake.trim()) && (
                <span>
                  <span className="font-bold text-accent-amber">
                    {result.unallocated_stake}
                  </span>{" "}
                  unallocated
                </span>
              )}
          </div>
        </>
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
      <TopBets result={result} />

      <MatchHeader result={result} />

      <YourBets result={result} />

      <AnalystNote note={result.analyst_note} />

      <AnalysisDetails result={result} />

      <BottomBar result={result} />
    </div>
  );
}
