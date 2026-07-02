import { cn } from "@/lib/utils";
import { formatMatchTime } from "@/lib/formatMatchTime";
import { type AnalysisResult, formatEv } from "@/lib/analysisResult";
import {
  CARD,
  classificationStyle,
  dataQualityStyle,
  ConfidenceMeter,
  Pill,
  ensemblePill,
} from "./helpers";

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
// Signal strip pills
// ─────────────────────────────────────────────────────────────
function SignalStrip({ result }: { result: AnalysisResult }) {
  const ens = ensemblePill(result.ensemble_check.alignment);

  // Best Stake EV across the four bets.
  const evs = [
    result.bet_1.ev,
    result.bet_2.ev,
    result.bet_3.parlay_ev,
    result.bet_4.jackpot_ev,
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
export function MatchHeader({ result }: { result: AnalysisResult }) {
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
