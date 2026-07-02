import { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  type AnalysisResult,
  formatEv,
  normalizeDimensions,
} from "@/lib/analysisResult";
import { CARD, Pill, SectionLabel, goalsDirectionStyle } from "./helpers";
import { plainConfidenceAdjustment } from "@/lib/plainEnglish";

// ─────────────────────────────────────────────────────────────
// Analysis details (collapsible)
// ─────────────────────────────────────────────────────────────
export function AnalysisDetails({ result }: { result: AnalysisResult }) {
  const [open, setOpen] = useState(false);
  const [plain, setPlain] = useState(false);
  const absences = result.player_intelligence.absences;
  const tactical = result.tactical_analysis;
  const dims = normalizeDimensions(result.confidence_scores.dimension_breakdown);
  const adjustments = result.confidence_scores.adjustments;
  const evaluated = result.markets_evaluated;
  const rejected = result.markets_rejected;

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
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate">
                  Confidence Breakdown
                </span>
                <button
                  type="button"
                  onClick={() => setPlain((v) => !v)}
                  className="rounded border border-border px-2 py-0.5 text-[11px] text-slate hover:text-foreground"
                >
                  ⓘ What does this mean? {plain ? "(on)" : "(off)"}
                </button>
              </div>

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
              {typeof result.confidence_scores.dimension_weighted_raw === "number" && (
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
              {typeof result.confidence_scores.final_confidence === "number" && (
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
