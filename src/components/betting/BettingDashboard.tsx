import { useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  AlertTriangle,
  MapPin,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  type AnalysisResult,
  type StraightBet,
  type SgpBet,
  type JackpotBet,
  type MarketRejected,
} from "@/lib/analysisResult";
import { computeEv } from "@/lib/calculate";
import {
  isCardsMarket,
  CARDS_MARKET_SOURCE_AVAILABLE,
  CARDS_UNAVAILABLE_SHORT,
} from "@/lib/dataGaps";
import { CARD, fmtOdds, sgpCombinedOdds, SectionLabel } from "./parts/helpers";
import { MatchHeader } from "./parts/MatchHeader";
import { TopBets } from "./parts/TopBets";
import { AnalysisDetails } from "./parts/AnalysisDetails";

// ─────────────────────────────────────────────────────────────
// Action-bet ("I placed this") draft passed up to the page.
// ─────────────────────────────────────────────────────────────
export interface ActionBetDraft {
  tier: number | string;
  market?: string;
  selection?: string;
  odds?: number;
  stake: number;
  model_probability?: number;
  ev?: number;
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

// ─────────────────────────────────────────────────────────────
// Formatting helpers (bet-row specific)
// ─────────────────────────────────────────────────────────────
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
  // Omit the bankroll suffix when the sizing bankroll wasn't recorded (older
  // cached results) — the previous hardcoded $50 fallback displayed a wrong
  // figure whenever the real bankroll differed.
  const bankroll =
    typeof bet.kelly_inputs?.bankroll === "number" ? bet.kelly_inputs.bankroll : null;
  return bankroll !== null
    ? `Kelly: ${k.fractional_kelly_pct}% of $${bankroll}`
    : `Kelly: ${k.fractional_kelly_pct}%`;
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
// Calibration sub-line + paper helpers
// ─────────────────────────────────────────────────────────────
function lambdaFromNote(note?: string): number | null {
  if (!note) return null;
  const m = note.match(/λ\s*=?\s*([0-9.]+)/);
  return m ? Number.parseFloat(m[1]) : null;
}

function CalibrationLine({ bet }: { bet: StraightBet }) {
  if (typeof bet.model_probability !== "number") return null;
  const cal = bet.model_probability * 100;
  const raw = bet.model_probability_raw;
  const lam = lambdaFromNote(bet.calibration_note);
  return (
    <span className="text-xs text-slate">
      p: <span className="font-semibold text-foreground">{cal.toFixed(1)}%</span>
      {typeof raw === "number" ? (
        <span className="text-slate">
          {" "}
          (raw {(raw * 100).toFixed(1)}%
          {lam != null ? `, λ ${lam}` : ""})
        </span>
      ) : null}
    </span>
  );
}

// A paper bet renders with a 📝 PAPER badge, blue-grey border, its paper_reason,
// and its would-be Kelly stake struck-through.
const PAPER_WRAP =
  "rounded-md border border-signal-blue/40 bg-signal-blue/5 p-3";

function PaperReason({ reason }: { reason?: string }) {
  if (!reason) return null;
  return (
    <span className="text-[13px] text-signal-blue">📝 Paper (not staked): {reason}</span>
  );
}

function wouldStakeText(bet: { kelly_result?: { recommended_stake?: number } }): string {
  const s = bet.kelly_result?.recommended_stake;
  return typeof s === "number" && Number.isFinite(s) ? `would stake $${s}` : "would stake —";
}

// ─────────────────────────────────────────────────────────────
// Individual bet rows for the unified "Your Bets" card
// ─────────────────────────────────────────────────────────────
function StraightBetRow({
  index,
  bet,
}: {
  index: number;
  bet: StraightBet;
}) {
  if (!bet.active) {
    return (
      <div className="flex flex-col gap-1 border-t border-border pt-4 first:border-t-0 first:pt-0">
        <span className="font-bold text-slate">
          ❌ BET {index} — Straight Bet
        </span>
        <span className="text-[13px] text-slate">
          {bet.skip_reason || "Inactive — no qualifying value."}
        </span>
      </div>
    );
  }

  const paper = bet.paper_bet === true;
  const kelly = kellyText(bet);
  return (
    <div
      className={cn(
        "flex flex-col gap-1 border-t border-border pt-4 first:border-t-0 first:pt-0",
        paper && PAPER_WRAP,
      )}
    >
      <span className={cn("font-bold", paper ? "text-signal-blue" : "text-signal-green")}>
        {paper ? "📝 PAPER" : "✅"} BET {index} — Straight Bet
      </span>
      <span className="text-base font-semibold text-foreground">
        {bet.market ?? "—"}: <span className="text-accent-amber">{bet.selection ?? "—"}</span>
      </span>
      <span className="text-sm text-slate">
        Odds: <span className="font-bold text-foreground">{fmtOdds(bet.odds)}</span>
        {" | "}
        Stake:{" "}
        {paper ? (
          <>
            <span className="font-semibold text-slate line-through">{wouldStakeText(bet)}</span>
            <span className="ml-1.5 font-bold text-signal-blue">$0 (PAPER)</span>
          </>
        ) : (
          <span className="font-bold text-signal-green">{bet.stake ?? "—"}</span>
        )}
      </span>
      <CalibrationLine bet={bet} />
      <span className="text-sm text-slate">
        EV: <span className={cn("font-bold", evTextClass(bet.ev))}>{evPctText(bet.ev)}</span>
        {kelly ? <> {" | "}{kelly}</> : null}
        {bet.ev_confidence ? (
          <span className="text-slate"> ({bet.ev_confidence} confidence)</span>
        ) : null}
      </span>
      {paper && <PaperReason reason={bet.paper_reason} />}
      <NavLabel label={bet.stake_label} />
      <ExpandableText text={bet.reasoning} />
    </div>
  );
}

function SgpBetRow({ bet }: { bet: SgpBet }) {
  if (!bet.active) {
    return (
      <div className="flex flex-col gap-1 border-t border-border pt-4">
        <span className="font-bold text-slate">
          ❌ BET 3 — 3-Leg Accumulator
        </span>
        <span className="text-[13px] text-slate">
          {bet.skip_reason || "Inactive — SGP not viable."}
        </span>
      </div>
    );
  }

  const paper = bet.paper_bet === true;
  const legs = bet.legs;
  const odds = sgpCombinedOdds(bet);
  const ret = bet.returns?.potential_return_realistic;
  return (
    <div className={cn("flex flex-col gap-1 border-t border-border pt-4", paper && PAPER_WRAP)}>
      <span className={cn("font-bold", paper ? "text-signal-blue" : "text-signal-green")}>
        {paper ? "📝 PAPER" : "✅"} BET 3 — 3-Leg Accumulator
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
        Stake:{" "}
        {paper ? (
          <span className="font-bold text-signal-blue">$0 (PAPER)</span>
        ) : (
          <span className="font-bold text-signal-green">{bet.stake ?? "$10"}</span>
        )}
        {ret ? (
          <>
            {" | "}
            Return: <span className="font-bold text-signal-green">~{ret}</span>
          </>
        ) : null}
        {" | "}
        EV: <span className={cn("font-bold", evTextClass(bet.parlay_ev))}>{evPctText(bet.parlay_ev)}</span>
      </span>
      {paper && <PaperReason reason={bet.paper_reason} />}
      <NavLabel
        label={
          bet.legs[0]?.stake_label
            ? "Soccer → Same Game Parlay\nAdd all legs above"
            : undefined
        }
      />
      <ExpandableText text={bet.reasoning} />
    </div>
  );
}

function JackpotBetRow({ bet }: { bet: JackpotBet }) {
  if (!bet.active) {
    const met = bet.class_c_signals?.length ?? 0;
    return (
      <div className="flex flex-col gap-1 border-t border-border pt-4">
        <span className="font-bold text-slate">❌ BET 4 — Jackpot</span>
        <span className="text-[13px] text-slate">
          {bet.skip_reason ||
            (met > 0
              ? `${met} of 3 CLASS C signals — jackpot not triggered.`
              : "No CLASS C signals this match.")}
        </span>
      </div>
    );
  }

  const paper = bet.paper_bet === true;
  const legs = bet.legs;
  const ret = bet.returns?.potential_return_realistic;
  return (
    <div className={cn("flex flex-col gap-1 border-t border-border pt-4", paper && PAPER_WRAP)}>
      <span className={cn("font-bold", paper ? "text-signal-blue" : "text-signal-green")}>
        {paper ? "📝 PAPER" : "✅"} BET 4 — Jackpot
      </span>
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
        Stake:{" "}
        {paper ? (
          <span className="font-bold text-signal-blue">$0 (PAPER)</span>
        ) : (
          <span className="font-bold text-signal-green">{bet.stake ?? "$10"}</span>
        )}
        {ret ? (
          <>
            {" | "}
            Return: <span className="font-bold text-signal-green">~{ret}</span>
          </>
        ) : null}
      </span>
      {paper && <PaperReason reason={bet.paper_reason} />}
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
        {(typeof result.real_bet_count === "number" ||
          typeof result.paper_bet_count === "number") && (
          <p className="text-xs font-semibold text-slate">
            <span className="text-signal-green">{result.real_bet_count ?? 0} real</span>
            {" · "}
            <span className="text-signal-blue">{result.paper_bet_count ?? 0} 📝 paper</span>
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
// All Candidates — every evaluated bet, always visible, honest labels
// ─────────────────────────────────────────────────────────────
interface Candidate {
  key: string;
  label: string;
  tier: number;
  market?: string;
  selectionLines: string[];
  selectionText: string;
  odds?: number;
  ev?: number; // APP-computed EV (never Claude's log_entry)
  modelProb?: number; // calibrated
  active: boolean;
  paper: boolean;
  shadow: boolean;
  minEv: number;
  stakeLabel?: string;
  suggestedStake: string;
  reason?: string;
}

function numOf(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function straightCandidate(
  bet: StraightBet | undefined,
  index: number,
  minEv: number,
): Candidate {
  const active = bet?.active === true && bet?.paper_bet !== true;
  const paper = bet?.active === true && bet?.paper_bet === true;
  const selText =
    [bet?.market, bet?.selection].filter(Boolean).join(" — ") || "—";
  return {
    key: `bet_${index}`,
    label: `Bet ${index} · Straight`,
    tier: index,
    market: bet?.market,
    selectionLines: [selText],
    selectionText: selText,
    odds: numOf(bet?.odds),
    ev: numOf(bet?.ev),
    modelProb: numOf(bet?.model_probability),
    active,
    paper,
    shadow: bet?.shadow_pick === true,
    minEv,
    stakeLabel: bet?.stake_label,
    suggestedStake: active
      ? bet?.stake ?? "—"
      : paper
        ? "$0 (paper)"
        : "$0 suggested",
    reason: bet?.skip_reason ?? bet?.paper_reason ?? undefined,
  };
}

function parlayCandidate(
  bet: SgpBet | JackpotBet | undefined,
  opts: {
    key: string;
    label: string;
    tier: number;
    odds?: number;
    ev?: number;
    modelProb?: number;
    minEv: number;
  },
): Candidate {
  const active = bet?.active === true && bet?.paper_bet !== true;
  const paper = bet?.active === true && bet?.paper_bet === true;
  const legs = bet?.legs ?? [];
  const lines = legs.map(
    (l) =>
      `${[l.market, l.selection].filter(Boolean).join(": ") || "—"}${
        typeof l.odds === "number" ? ` @ ${fmtOdds(l.odds)}` : ""
      }`,
  );
  const stakeLabel =
    legs
      .map((l) => l.stake_label)
      .filter(Boolean)
      .join("  +  ") || undefined;
  return {
    key: opts.key,
    label: opts.label,
    tier: opts.tier,
    market: bet?.bet_type,
    selectionLines: lines.length > 0 ? lines : ["—"],
    selectionText: legs
      .map((l) => [l.market, l.selection].filter(Boolean).join(": "))
      .filter(Boolean)
      .join("  /  "),
    odds: numOf(opts.odds),
    ev: numOf(opts.ev),
    modelProb: numOf(opts.modelProb),
    active,
    paper,
    shadow: bet?.shadow_pick === true,
    minEv: opts.minEv,
    stakeLabel,
    suggestedStake: active
      ? bet?.stake ?? "—"
      : paper
        ? "$0 (paper)"
        : "$0 suggested",
    reason: bet?.skip_reason ?? bet?.paper_reason ?? undefined,
  };
}

function buildCandidates(result: AnalysisResult): Candidate[] {
  const b3 = result.bet_3;
  const b4 = result.bet_4;
  return [
    straightCandidate(result.bet_1, 1, 0.05),
    straightCandidate(result.bet_2, 2, 0.03),
    parlayCandidate(b3, {
      key: "bet_3",
      label: "Bet 3 · Same Game Parlay",
      tier: 3,
      odds: sgpCombinedOdds(b3) ?? b3?.combined_odds_sgp,
      ev: b3?.parlay_ev,
      modelProb: b3?.p_joint,
      minEv: 0.05,
    }),
    parlayCandidate(b4, {
      key: "bet_4",
      label: "Bet 4 · Jackpot",
      tier: 4,
      odds: b4?.combined_odds,
      ev: b4?.jackpot_ev,
      modelProb: b4?.jackpot_ev_inputs?.p_final,
      minEv: 0.05,
    }),
  ];
}

function valueBadge(c: Candidate): {
  text: string;
  cls: string;
  subtitle?: string;
} {
  if (c.active && !c.paper)
    return {
      text: "✅ VALUE",
      cls: "border-signal-green/50 bg-signal-green/15 text-signal-green",
    };
  if (c.paper)
    return {
      text: "📝 PAPER",
      cls: "border-signal-blue/50 bg-signal-blue/15 text-signal-blue",
    };
  if (typeof c.ev === "number" && c.ev < 0)
    return {
      text: "⛔ NO VALUE",
      cls: "border-signal-red/50 bg-signal-red/15 text-signal-red",
      subtitle:
        "Price is worse than our estimated chance — expected to lose money over time",
    };
  return {
    text: "⚠️ BELOW THRESHOLD",
    cls: "border-accent-amber/50 bg-accent-amber/15 text-accent-amber",
  };
}

const pct = (v?: number) =>
  typeof v === "number" && Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : "—";
const evPct = (v?: number) =>
  typeof v === "number" && Number.isFinite(v)
    ? `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`
    : "—";

function CandidateCard({
  c,
  onPlaceActionBet,
}: {
  c: Candidate;
  onPlaceActionBet?: (draft: ActionBetDraft) => void;
}) {
  const [formOpen, setFormOpen] = useState(false);
  const [stake, setStake] = useState("");
  const [oddsStr, setOddsStr] = useState(
    typeof c.odds === "number" ? String(c.odds) : "",
  );
  const [placed, setPlaced] = useState(false);

  const badge = valueBadge(c);
  const marketImplied =
    typeof c.odds === "number" && c.odds > 0 ? 1 / c.odds : undefined;

  const confirm = () => {
    const stakeNum = Number(stake);
    const oddsNum = Number(oddsStr);
    if (!Number.isFinite(stakeNum) || stakeNum <= 0) return;
    onPlaceActionBet?.({
      tier: c.tier,
      market: c.market ?? c.label,
      selection: c.selectionText || c.selectionLines.join(" / "),
      odds: Number.isFinite(oddsNum) && oddsNum > 0 ? oddsNum : c.odds,
      stake: stakeNum,
      model_probability: c.modelProb,
      ev: c.ev,
    });
    setPlaced(true);
    setFormOpen(false);
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-card/40 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate">
          {c.label}
        </span>
        <div className="flex items-center gap-1.5">
          {c.shadow && (
            <span className="rounded-full border border-[#a78bfa]/50 bg-[#a78bfa]/15 px-2 py-0.5 text-[11px] font-bold text-[#a78bfa]">
              👻 SHADOW
            </span>
          )}
          <span
            className={cn(
              "rounded-full border px-2 py-0.5 text-[11px] font-bold",
              badge.cls,
            )}
          >
            {badge.text}
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-0.5">
        {c.selectionLines.map((line, i) => (
          <p key={i} className="text-sm font-semibold text-foreground">
            {line}
          </p>
        ))}
        <p className="text-xs text-slate">
          Odds: <span className="font-semibold text-foreground">{fmtOdds(c.odds)}</span>
        </p>
      </div>

      {badge.subtitle && (
        <p className="text-xs text-signal-red">{badge.subtitle}</p>
      )}

      <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs">
        <span className="text-slate">
          App EV:{" "}
          <span
            className={cn(
              "font-bold",
              typeof c.ev === "number" && c.ev < 0
                ? "text-signal-red"
                : "text-signal-green",
            )}
          >
            {evPct(c.ev)}
          </span>
        </span>
        <span className="text-slate">
          Our estimate:{" "}
          <span className="font-semibold text-foreground">{pct(c.modelProb)}</span>
        </span>
        <span className="text-slate">
          Market's estimate:{" "}
          <span className="font-semibold text-foreground">{pct(marketImplied)}</span>
        </span>
      </div>

      {c.stakeLabel && (
        <p className="flex items-start gap-1 text-xs text-slate">
          <MapPin size={12} className="mt-0.5 shrink-0 text-accent-amber" />
          <span>{c.stakeLabel}</span>
        </p>
      )}

      <p className="text-xs text-slate">
        Suggested stake:{" "}
        <span className="font-semibold text-foreground">{c.suggestedStake}</span>
      </p>

      {c.reason && !c.active && (
        <p className="text-xs italic text-slate/80">{c.reason}</p>
      )}

      {onPlaceActionBet && (
        <div className="border-t border-border pt-2">
          {placed ? (
            <p className="text-xs font-semibold text-signal-green">
              💵 Logged as an action bet.
            </p>
          ) : !formOpen ? (
            <button
              type="button"
              onClick={() => setFormOpen(true)}
              className="text-xs font-semibold text-accent-amber hover:underline"
            >
              💵 I placed this
            </button>
          ) : (
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex flex-col gap-0.5 text-[11px] text-slate">
                Stake ($)
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={stake}
                  onChange={(e) => setStake(e.target.value)}
                  className="w-24 rounded border border-border bg-background px-2 py-1 text-sm text-foreground"
                />
              </label>
              <label className="flex flex-col gap-0.5 text-[11px] text-slate">
                Odds taken
                <input
                  type="number"
                  min="1"
                  step="0.01"
                  value={oddsStr}
                  onChange={(e) => setOddsStr(e.target.value)}
                  className="w-24 rounded border border-border bg-background px-2 py-1 text-sm text-foreground"
                />
              </label>
              <button
                type="button"
                onClick={confirm}
                className="rounded bg-accent-amber px-3 py-1.5 text-xs font-bold text-background"
              >
                Confirm
              </button>
              <button
                type="button"
                onClick={() => setFormOpen(false)}
                className="px-2 py-1.5 text-xs text-slate hover:text-foreground"
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RejectedMarkets({ markets }: { markets: MarketRejected[] }) {
  const [open, setOpen] = useState(false);
  if (!markets || markets.length === 0) return null;
  return (
    <div className="border-t border-border pt-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 text-xs font-semibold text-slate hover:text-foreground"
      >
        {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        Show {markets.length} rejected market{markets.length === 1 ? "" : "s"}
      </button>
      {open && (
        <div className="mt-2 flex flex-col gap-1.5">
          {markets.map((m, i) => {
            // A cards rejection is a neutral data-gap note (not a red
            // "rejected" row) only while no source carries cards at all, or
            // when this particular run had no cards price to evaluate. Since
            // tier 8.3 the Pinnacle C9B feed can price cards, so a cards
            // rejection WITH ev inputs is a genuine model rejection.
            if (
              isCardsMarket(m.market) &&
              (!CARDS_MARKET_SOURCE_AVAILABLE || (m.ev == null && !m.ev_inputs))
            ) {
              return (
                <div
                  key={i}
                  className="flex flex-wrap items-center justify-between gap-x-4 gap-y-0.5 rounded border border-border bg-card/30 px-3 py-1.5 text-xs"
                >
                  <span className="font-semibold text-foreground">
                    {m.market ?? "—"}
                  </span>
                  <span className="text-slate">{CARDS_UNAVAILABLE_SHORT}</span>
                  <span className="w-full text-slate/80">
                    No cards price this run (retail feed carries none; Pinnacle
                    C9B offered no cards market) — data gap, not a model
                    judgment.
                  </span>
                </div>
              );
            }
            const recomputed = computeEv(
              m.ev_inputs?.model_probability,
              m.ev_inputs?.decimal_odds,
            );
            const evText =
              recomputed !== undefined
                ? evPct(recomputed)
                : typeof m.ev === "number"
                  ? `${evPct(m.ev)} (unverified)`
                  : "—";
            return (
              <div
                key={i}
                className="flex flex-wrap items-center justify-between gap-x-4 gap-y-0.5 rounded border border-border bg-card/30 px-3 py-1.5 text-xs"
              >
                <span className="font-semibold text-foreground">
                  {m.market ?? "—"}
                </span>
                <span className="text-slate">EV: {evText}</span>
                {m.reason && (
                  <span className="w-full text-slate/80">{m.reason}</span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function CandidatesCard({
  result,
  onPlaceActionBet,
}: {
  result: AnalysisResult;
  onPlaceActionBet?: (draft: ActionBetDraft) => void;
}) {
  const candidates = buildCandidates(result);
  return (
    <div className={cn(CARD, "flex flex-col gap-4")}>
      <div className="flex flex-col gap-1">
        <h2 className="text-xl font-bold text-foreground">
          📋 All Candidates
        </h2>
        <p className="text-sm text-slate">Every bet evaluated this match</p>
      </div>

      <div className="flex flex-col gap-3">
        {candidates.map((c) => (
          <CandidateCard
            key={c.key}
            c={c}
            onPlaceActionBet={onPlaceActionBet}
          />
        ))}
      </div>

      <RejectedMarkets markets={result.markets_rejected ?? []} />
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
export function BettingDashboard({
  result,
  onPlaceActionBet,
}: {
  result: AnalysisResult;
  onPlaceActionBet?: (draft: ActionBetDraft) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <TopBets result={result} />

      <MatchHeader result={result} />

      <YourBets result={result} />

      <CandidatesCard result={result} onPlaceActionBet={onPlaceActionBet} />

      <AnalystNote note={result.analyst_note} />

      <AnalysisDetails result={result} />

      <BottomBar result={result} />
    </div>
  );
}
