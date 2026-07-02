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
} from "@/lib/analysisResult";
import { CARD, fmtOdds, sgpCombinedOdds, SectionLabel } from "./parts/helpers";
import { MatchHeader } from "./parts/MatchHeader";
import { TopBets } from "./parts/TopBets";
import { AnalysisDetails } from "./parts/AnalysisDetails";

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
  const bankroll =
    typeof bet.kelly_inputs?.bankroll === "number" ? bet.kelly_inputs.bankroll : 50;
  return `Kelly: ${k.fractional_kelly_pct}% of $${bankroll}`;
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

  const paper = bet.paper_bet === true;
  const legs = bet.legs ?? [];
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

  const paper = bet.paper_bet === true;
  const legs = bet.legs ?? [];
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
