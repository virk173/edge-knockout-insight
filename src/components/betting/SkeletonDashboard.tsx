// Loading skeleton shown while Claude generates the analysis. Mirrors the
// BettingDashboard layout (header + two tier cards + jackpot + bottom bar) so
// the real content swaps in without layout shift.

const CARD = "rounded-xl border border-border bg-background p-6";
const PULSE = "animate-pulse rounded-md bg-border/60";

function SkeletonCard({ lines = 4 }: { lines?: number }) {
  return (
    <div className={`${CARD} flex flex-col gap-4`}>
      <div className={`${PULSE} h-3 w-32`} />
      <div className="flex flex-col items-center gap-2 py-2">
        <div className={`${PULSE} h-5 w-40`} />
        <div className={`${PULSE} h-7 w-28`} />
      </div>
      <div className="grid grid-cols-3 gap-2">
        <div className={`${PULSE} h-10`} />
        <div className={`${PULSE} h-10`} />
        <div className={`${PULSE} h-10`} />
      </div>
      <div className="flex flex-col gap-2">
        {Array.from({ length: lines }).map((_, i) => (
          <div key={i} className={`${PULSE} h-3`} style={{ width: `${90 - i * 12}%` }} />
        ))}
      </div>
      <div className={`${PULSE} mt-auto h-11 w-full`} />
    </div>
  );
}

export function SkeletonDashboard() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading analysis">
      {/* Match header */}
      <div className={`${CARD} grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4`}>
        <div className="flex min-w-0 flex-col gap-3">
          <div className={`${PULSE} h-7 w-3/4`} />
          <div className={`${PULSE} h-3 w-40`} />
          <div className="flex flex-wrap gap-2">
            <div className={`${PULSE} h-7 w-44`} />
            <div className={`${PULSE} h-7 w-36`} />
          </div>
        </div>
        <div className={`${PULSE} h-28 w-28 rounded-full`} />
      </div>

      {/* Tier 1 + Tier 2 */}
      <div className="grid gap-4 md:grid-cols-2">
        <SkeletonCard />
        <SkeletonCard lines={5} />
      </div>

      {/* Tier 3 */}
      <SkeletonCard lines={3} />

      {/* Bottom bar */}
      <div className={`${CARD} flex items-center gap-6 py-4`}>
        <div className={`${PULSE} h-4 w-32`} />
        <div className={`${PULSE} h-4 w-28`} />
      </div>
    </div>
  );
}
