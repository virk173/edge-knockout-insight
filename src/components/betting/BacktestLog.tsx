import { useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  type LogEntry,
  type Outcome,
  computeEvRealised,
  computeSummary,
  countRecommendations,
  cycleOutcome,
  downloadCsv,
  computeClvSummary,
  computeActionBetSummary,
  computeCalibrationTable,
} from "@/lib/backtestLog";
import { getCalibration } from "@/lib/calibration";

const OUTCOME_BADGE: Record<Outcome, string> = {
  PENDING: "border-slate/40 bg-slate/10 text-slate",
  WON: "border-signal-green/50 bg-signal-green/10 text-signal-green",
  LOST: "border-signal-red/50 bg-signal-red/10 text-signal-red",
  // Settled-neutral: stake returned (AH push, DNB draw, voided market).
  PUSH: "border-signal-orange/50 bg-signal-orange/10 text-signal-orange",
  VOID: "border-slate/40 bg-slate/10 text-slate line-through",
};

function clvNode(rec: { clv_pct?: number; closing_source?: string }): React.ReactNode {
  if (typeof rec.clv_pct !== "number" || !Number.isFinite(rec.clv_pct)) {
    return <span className="text-slate">CLV: no close captured</span>;
  }
  const cls = rec.clv_pct >= 0 ? "text-signal-green" : "text-signal-red";
  const sign = rec.clv_pct > 0 ? "+" : "";
  return (
    <span className={cls}>
      CLV: {sign}
      {rec.clv_pct.toFixed(1)}% vs {rec.closing_source ?? "?"} close
    </span>
  );
}

function num(value: number | undefined, digits = 2): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return value.toFixed(digits);
}

function signedAmber(value: number | null, suffix = "", digits = 1): React.ReactNode {
  if (value === null || !Number.isFinite(value)) {
    return <span className="text-slate">—</span>;
  }
  const cls = value >= 0 ? "text-accent-amber" : "text-signal-red";
  const sign = value > 0 ? "+" : "";
  return (
    <span className={cls}>
      {sign}
      {value.toFixed(digits)}
      {suffix}
    </span>
  );
}

export function BacktestLog({
  entries,
  onCycleOutcome,
  onClear,
  onSetManualClosingOdds,
}: {
  entries: LogEntry[];
  onCycleOutcome: (entryId: string, recIndex: number, next: Outcome) => void;
  onClear: () => void;
  onSetManualClosingOdds?: (entryId: string, recIndex: number, odds: number) => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const summary = computeSummary(entries);
  const totalRecs = countRecommendations(entries);
  const clv = computeClvSummary(entries);
  const actionSummary = computeActionBetSummary(entries);
  const calTable = computeCalibrationTable(entries);
  const calibration = getCalibration();

  return (
    <div className="flex w-full max-w-5xl flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-bold tracking-tight text-foreground">
          Backtesting Log
        </h2>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => downloadCsv(entries)}
            disabled={entries.length === 0}
            className="rounded-md border border-border px-3 py-1.5 text-xs font-semibold text-foreground transition-colors hover:border-accent-amber hover:text-accent-amber disabled:cursor-not-allowed disabled:opacity-50"
          >
            Export to CSV
          </button>
          <button
            type="button"
            onClick={() => setConfirmOpen(true)}
            disabled={entries.length === 0}
            className="rounded-md border border-signal-red/50 px-3 py-1.5 text-xs font-semibold text-signal-red transition-colors hover:bg-signal-red/10 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Clear Log
          </button>
        </div>
      </div>

      {/* Summary stats */}
      <div className="rounded-xl border border-border bg-card/40 p-6">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          <Stat label="Total recommendations">
            <span className="text-accent-amber">{summary.totalRecommendations}</span>
          </Stat>
          <Stat label="Total staked">
            <span className="text-foreground">${num(summary.totalStaked)}</span>
          </Stat>
          <Stat label="Total returned">
            <span className="text-foreground">${num(summary.totalReturned)}</span>
          </Stat>
          <Stat label="ROI">{signedAmber(summary.roi, "%")}</Stat>
          <Stat label="Win rate">
            {summary.winRate === null ? (
              <span className="text-slate">—</span>
            ) : (
              <span className="text-accent-amber">{summary.winRate.toFixed(1)}%</span>
            )}
          </Stat>
          <Stat label="Avg EV at bet">{signedAmber(summary.avgEv, "", 3)}</Stat>
          <Stat label="Avg confidence">
            {summary.avgConfidence === null ? (
              <span className="text-slate">—</span>
            ) : (
              <span className="text-accent-amber">
                {summary.avgConfidence.toFixed(0)}
              </span>
            )}
          </Stat>
          <Stat label="Record (W/L/P)">
            <span className="text-foreground">
              <span className="text-signal-green">{summary.wonCount}</span>
              {" / "}
              <span className="text-signal-red">{summary.lostCount}</span>
              {" / "}
              <span className="text-slate">{summary.pendingCount}</span>
            </span>
          </Stat>
        </div>

        {/* Ensemble alignment breakdown — the headline backtesting signal. */}
        <div className="mt-6 border-t border-border pt-4">
          <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate">
            Win rate by ensemble alignment
          </p>
          {summary.alignment.length === 0 ? (
            <p className="text-sm text-slate">No decided bets yet.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {summary.alignment.map((a) => (
                <div
                  key={a.bucket}
                  className="flex items-center justify-between gap-3 font-mono text-sm"
                >
                  <span className="font-semibold text-foreground">{a.bucket}</span>
                  <span className="text-slate">
                    <span className="text-accent-amber">{a.bets}</span> bets
                    {" · "}
                    {a.winRate === null ? (
                      <span className="text-slate">no result</span>
                    ) : (
                      <span className="text-accent-amber">
                        {a.winRate.toFixed(0)}% win
                      </span>
                    )}
                    {" "}
                    <span className="text-signal-green">{a.won}W</span>
                    {" "}
                    <span className="text-signal-red">{a.lost}L</span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* CLV aggregate */}
      <div className="rounded-xl border border-border bg-card/40 p-6">
        <p className="mb-4 text-xs font-semibold uppercase tracking-wide text-slate">
          Closing Line Value (CLV)
        </p>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <Stat label="Bets with CLV">
            <span className="text-accent-amber">{clv.betsWithClv}</span>
          </Stat>
          <Stat label="Avg CLV">{signedAmber(clv.avgClv, "%")}</Stat>
          <Stat label="Beat the close">
            {clv.beatPct === null ? (
              <span className="text-slate">—</span>
            ) : (
              <span className="text-accent-amber">
                {clv.beatCount} of {clv.betsWithClv} ({clv.beatPct.toFixed(0)}%)
              </span>
            )}
          </Stat>
        </div>

        {clv.byGroup.length > 0 && (
          <div className="mt-6 border-t border-border pt-4">
            <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate">
              CLV by market group
            </p>
            <div className="flex flex-col gap-2">
              {clv.byGroup.map((g) => (
                <div
                  key={g.bucket}
                  className="flex items-center justify-between gap-3 font-mono text-sm"
                >
                  <span className="font-semibold text-foreground">{g.bucket}</span>
                  <span className="text-slate">
                    <span className="text-accent-amber">{g.bets}</span> bets · avg{" "}
                    {signedAmber(g.avgClv, "%")} · {g.beat} beat
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div
          className={`mt-6 rounded-md border px-4 py-3 text-sm font-semibold ${
            clv.verdict === "EDGE"
              ? "border-signal-green/50 bg-signal-green/10 text-signal-green"
              : clv.verdict === "NEGATIVE"
                ? "border-signal-red/50 bg-signal-red/10 text-signal-red"
                : clv.verdict === "NEUTRAL"
                  ? "border-accent-amber/50 bg-accent-amber/10 text-accent-amber"
                  : "border-border bg-background/60 text-slate"
          }`}
        >
          {clv.verdictText}
        </div>

        {actionSummary.count > 0 && (
          <div className="mt-4 rounded-md border border-accent-amber/40 bg-accent-amber/5 px-4 py-3 text-sm">
            <span className="font-semibold text-accent-amber">💵 Action bets:</span>{" "}
            <span className="text-foreground">{actionSummary.count}</span>
            {", P/L "}
            <span
              className={
                actionSummary.pl >= 0 ? "text-signal-green" : "text-signal-red"
              }
            >
              {actionSummary.pl >= 0 ? "+" : "−"}${Math.abs(actionSummary.pl).toFixed(2)}
            </span>
            {", avg CLV "}
            <span className="text-foreground">
              {actionSummary.avgClv === null
                ? "—"
                : `${actionSummary.avgClv >= 0 ? "+" : ""}${actionSummary.avgClv.toFixed(1)}%`}
            </span>
            <span className="ml-1 text-xs text-slate">
              (excluded from the edge verdict above)
            </span>
          </div>
        )}
      </div>


      {/* Calibration */}
      <div className="rounded-xl border border-border bg-card/40 p-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate">
            Probability calibration
          </p>
          <span className="font-mono text-xs text-slate">
            λ <span className="text-accent-amber">{calibration.lambda}</span> · n{" "}
            <span className="text-accent-amber">{calibration.n}</span> · Brier{" "}
            <span className="text-accent-amber">
              {calibration.brier === null ? "—" : calibration.brier.toFixed(4)}
            </span>
          </span>
        </div>
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-4 gap-2 border-b border-border pb-2 font-mono text-[10px] uppercase tracking-wide text-slate">
            <span>Bucket</span>
            <span className="text-right">Predicted</span>
            <span className="text-right">Realized</span>
            <span className="text-right">Count</span>
          </div>
          {calTable.map((row) => (
            <div
              key={row.label}
              className="grid grid-cols-4 gap-2 font-mono text-sm"
            >
              <span className="font-semibold text-foreground">{row.label}</span>
              <span className="text-right text-slate">
                {row.predictedAvg === null ? "—" : `${row.predictedAvg.toFixed(0)}%`}
              </span>
              <span className="text-right text-accent-amber">
                {row.realizedWinPct === null ? "—" : `${row.realizedWinPct.toFixed(0)}%`}
              </span>
              <span className="text-right text-slate">{row.count}</span>
            </div>
          ))}
        </div>
      </div>


      {/* Entries */}
      {entries.length === 0 ? (
        <p className="pt-6 text-center text-sm text-slate">
          No log entries yet. Run an analysis to record recommendations here.
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          {[...entries]
            .reverse()
            .map((entry) => (
              <div
                key={entry.id}
                className="rounded-xl border border-border bg-card/40 p-6"
              >
                <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-base font-bold text-foreground">
                    {entry.match ?? "Unknown match"}
                  </span>
                  <span className="font-mono text-xs text-slate">
                    {entry.date ?? "—"}
                    {entry.round ? ` · ${entry.round}` : ""}
                  </span>
                </div>

                <div className="flex flex-col gap-3">
                  {entry.recommendations.length === 0 ? (
                    <p className="text-sm text-slate">No recommendations recorded.</p>
                  ) : (
                    entry.recommendations.map((rec, i) => {
                      const evReal = computeEvRealised(rec);
                      return (
                        <div
                          key={i}
                          className={`rounded-lg border p-4 ${
                            rec.action_bet
                              ? "border-accent-amber/40 bg-accent-amber/5"
                              : rec.paper
                                ? "border-signal-blue/40 bg-signal-blue/5"
                                : "border-border bg-background/60"
                          }`}
                        >
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div className="flex flex-col gap-1">
                              <span className="text-sm font-semibold text-foreground">
                                {rec.tier !== undefined && rec.tier !== null && (
                                  <span className="mr-2 text-xs font-bold uppercase text-slate">
                                    T{rec.tier}
                                  </span>
                                )}
                                {rec.action_bet && (
                                  <span className="mr-2 rounded border border-accent-amber/40 bg-accent-amber/10 px-1.5 py-0.5 text-[10px] font-bold uppercase text-accent-amber">
                                    💵 Action
                                  </span>
                                )}
                                {rec.shadow && (
                                  <span className="mr-2 rounded border border-[#a78bfa]/40 bg-[#a78bfa]/10 px-1.5 py-0.5 text-[10px] font-bold uppercase text-[#a78bfa]">
                                    👻 Shadow
                                  </span>
                                )}
                                {rec.paper && !rec.action_bet && (
                                  <span className="mr-2 rounded border border-signal-blue/40 bg-signal-blue/10 px-1.5 py-0.5 text-[10px] font-bold uppercase text-signal-blue">
                                    📝 Paper
                                  </span>
                                )}
                                {rec.market ?? "—"}
                              </span>
                              <span className="text-sm text-slate">
                                {rec.selection ?? "—"}
                              </span>
                            </div>
                            <button
                              type="button"
                              onClick={() =>
                                onCycleOutcome(entry.id, i, cycleOutcome(rec.outcome))
                              }
                              className={`rounded-md border px-3 py-1 text-xs font-bold uppercase tracking-wide transition-opacity hover:opacity-80 ${OUTCOME_BADGE[rec.outcome]}`}
                              aria-label="Cycle outcome"
                            >
                              {rec.outcome}
                            </button>
                          </div>

                          <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 font-mono text-xs sm:grid-cols-4">
                            <Field label="Odds" value={num(rec.odds)} />
                            <Field label="Stake" value={rec.stake ?? "—"} />
                            <Field
                              label="Model prob"
                              value={
                                typeof rec.model_probability === "number"
                                  ? rec.model_probability.toFixed(3)
                                  : "—"
                              }
                            />
                            <Field
                              label="EV"
                              value={
                                typeof rec.ev === "number"
                                  ? `${rec.ev >= 0 ? "+" : ""}${rec.ev.toFixed(3)}`
                                  : "—"
                              }
                              valueClass={
                                typeof rec.ev === "number" && rec.ev < 0
                                  ? "text-signal-red"
                                  : "text-accent-amber"
                              }
                            />
                            <Field
                              label="Confidence"
                              value={
                                typeof rec.confidence === "number"
                                  ? String(rec.confidence)
                                  : "—"
                              }
                            />
                            <Field
                              label="Ensemble"
                              value={rec.ensemble_alignment ?? "—"}
                            />
                            <Field
                              label="Sharp signal"
                              value={rec.sharp_signal ?? "—"}
                            />
                            <Field
                              label="EV realised"
                              value={
                                evReal === null ? "PENDING" : evReal.toFixed(2)
                              }
                              valueClass={
                                evReal === null
                                  ? "text-slate"
                                  : evReal >= 0
                                    ? "text-accent-amber"
                                    : "text-signal-red"
                              }
                            />
                          </div>

                          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3 text-xs font-semibold">
                            {clvNode(rec)}
                            <label className="flex items-center gap-2 text-slate">
                              <span className="font-normal">Closing odds:</span>
                              <input
                                type="number"
                                step="0.01"
                                min="1"
                                defaultValue={
                                  typeof rec.closing_odds === "number"
                                    ? rec.closing_odds
                                    : ""
                                }
                                onBlur={(e) => {
                                  const v = parseFloat(e.target.value);
                                  if (Number.isFinite(v) && v > 1) {
                                    onSetManualClosingOdds?.(entry.id, i, v);
                                  }
                                }}
                                className="w-20 rounded border border-border bg-background px-2 py-1 font-mono text-xs text-foreground focus:border-accent-amber focus:outline-none"
                                placeholder="—"
                              />
                            </label>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>

                {entry.notes && (
                  <p className="mt-4 border-t border-border pt-3 text-xs text-slate">
                    {entry.notes}
                  </p>
                )}
              </div>
            ))}
        </div>
      )}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent className="border-border bg-card text-foreground">
          <AlertDialogHeader>
            <AlertDialogTitle>Clear backtesting log?</AlertDialogTitle>
            <AlertDialogDescription className="text-slate">
              This will delete all {totalRecs} log{" "}
              {totalRecs === 1 ? "entry" : "entries"}. This cannot be undone.
              Confirm?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-border bg-transparent text-foreground hover:bg-background">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={onClear}
              className="bg-signal-red text-white hover:bg-signal-red/90"
            >
              Delete all
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs uppercase tracking-wide text-slate">{label}</span>
      <span className="font-mono text-xl font-bold">{children}</span>
    </div>
  );
}

function Field({
  label,
  value,
  valueClass = "text-foreground",
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wide text-slate">{label}</span>
      <span className={`break-words ${valueClass}`}>{value}</span>
    </div>
  );
}
