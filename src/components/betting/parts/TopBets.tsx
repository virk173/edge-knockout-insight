import { cn } from "@/lib/utils";
import { formatMatchTime } from "@/lib/formatMatchTime";
import { type AnalysisResult, type TierLeg } from "@/lib/analysisResult";
import { CARD, fmtOdds, sgpCombinedOdds } from "./helpers";

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

export function TopBets({ result }: { result: AnalysisResult }) {
  const b1 = result.bet_1;
  const b2 = result.bet_2;
  const b3 = result.bet_3;
  const b4 = result.bet_4;

  const rows: TopBetRow[] = [];

  if (b1.active) {
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

  if (b2.active) {
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

  if (b3.active) {
    const legs = b3.legs;
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
