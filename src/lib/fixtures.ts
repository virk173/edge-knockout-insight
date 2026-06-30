// API-Football fixtures fetching + status logic. API key lives server-side
// (APIFOOTBALL_KEY) and is used by the api-proxy server function.

import { apiFootballGet } from "./apiFootball";

export interface Fixture {
  id: number;
  home: string;
  away: string;
  homeId: number;
  awayId: number;
  kickoffUtc: string; // ISO string
  isTomorrow: boolean;
  referee: string | null;
  round: string | null;
  venueName: string | null;
  venueCity: string | null;
  // API-Football fixture status short code (NS, 1H, HT, FT, AET, PEN, …).
  statusShort: string;
}

export type MatchStatus =
  | "TOO_EARLY"
  | "OPTIMAL"
  | "VALID"
  | "LATE"
  | "SKIP"
  | "TOMORROW";

export interface AnalysedMatch extends Fixture {
  minutesUntilKickoff: number;
  status: MatchStatus;
  // Whether pre-match analysis is blocked (match live / finished).
  blocked: boolean;
}

// API-Football status short codes that mean the match is live / in progress.
const LIVE_STATUSES = new Set([
  "1H",
  "HT",
  "2H",
  "ET",
  "BT",
  "P",
  "SUSP",
  "INT",
  "LIVE",
]);
// Codes that mean the match has finished (or otherwise has no pre-match bets).
const FINISHED_STATUSES = new Set(["FT", "AET", "PEN", "ABD", "AWD", "WO"]);

// Whether pre-match analysis should be BLOCKED. Driven primarily by the
// API-Football status (live / finished), with a kickoff-time safety net for the
// case where the status feed lags behind the real kickoff.
export function isMatchBlocked(
  statusShort: string,
  minutesUntilKickoff: number,
): boolean {
  if (LIVE_STATUSES.has(statusShort)) return true;
  if (FINISHED_STATUSES.has(statusShort)) return true;
  if (minutesUntilKickoff <= 0) return true;
  return false;
}

export type TimingTone = "green" | "amber" | "red" | "slate" | "blocked";

export interface TimingBand {
  tone: TimingTone;
  label: string;
}

// Warning-only timing band (never blocks pre-kickoff). Blocking is decided
// separately by isMatchBlocked() using the API status.
export function timingBand(
  minutesUntilKickoff: number,
  blocked: boolean,
): TimingBand {
  if (blocked) {
    return {
      tone: "blocked",
      label: "Match in progress or finished — no pre-match bets available",
    };
  }
  const m = minutesUntilKickoff;
  if (m > 90) {
    return {
      tone: "slate",
      label: "⏳ TOO EARLY — optimal window opens at T-90 (lineups not yet confirmed)",
    };
  }
  if (m >= 75) {
    return {
      tone: "green",
      label: "✅ OPTIMAL — lineups confirmed, full analysis window",
    };
  }
  if (m >= 40) {
    return { tone: "amber", label: "⚠️ VALID — within analysis window" };
  }
  if (m >= 20) {
    return {
      tone: "amber",
      label: "⚠️ LATE — limited time to act after analysis completes",
    };
  }
  return {
    tone: "red",
    label:
      "🔴 VERY LATE — under 20 minutes to kickoff, act immediately if analysis recommends a bet",
  };
}


function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

interface ApiFixtureResponse {
  errors?: unknown;
  response?: Array<{
    fixture: {
      id: number;
      date: string;
      referee?: string | null;
      venue?: { name?: string | null; city?: string | null } | null;
      status?: { short?: string | null } | null;
    };
    league?: { round?: string | null };
    teams: {
      home: { id: number; name: string };
      away: { id: number; name: string };
    };
  }>;
}

async function fetchFixturesForDate(
  date: string,
  isTomorrow: boolean,
): Promise<Fixture[]> {
  const path = `/fixtures?league=1&season=2026&date=${date}`;
  const response = await apiFootballGet(path, {
    callLabel: isTomorrow ? "C1-tomorrow" : "C1-today",
  });
  const items = (response ?? []) as NonNullable<ApiFixtureResponse["response"]>;

  return items.map((item) => ({
    id: item.fixture.id,
    home: item.teams.home.name,
    away: item.teams.away.name,
    homeId: item.teams.home.id,
    awayId: item.teams.away.id,
    kickoffUtc: item.fixture.date,
    isTomorrow,
    referee: item.fixture.referee ?? null,
    round: item.league?.round ?? null,
    venueName: item.fixture.venue?.name ?? null,
    venueCity: item.fixture.venue?.city ?? null,
    statusShort: item.fixture.status?.short ?? "NS",
  }));
}


export function computeStatus(
  minutesUntilKickoff: number,
  isTomorrow: boolean,
): MatchStatus {
  if (isTomorrow) return "TOMORROW";
  if (minutesUntilKickoff > 90) return "TOO_EARLY";
  if (minutesUntilKickoff >= 75) return "OPTIMAL";
  if (minutesUntilKickoff >= 40) return "VALID";
  if (minutesUntilKickoff >= 20) return "LATE";
  return "SKIP";
}

export interface AnalysisResult {
  matches: AnalysedMatch[];
  apiCallsUsed: number;
}

export async function runAnalysis(): Promise<AnalysisResult> {
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  let apiCallsUsed = 0;
  const todayFixtures = await fetchFixturesForDate(isoDate(now), false);
  apiCallsUsed += 1;
  const tomorrowFixtures = await fetchFixturesForDate(isoDate(tomorrow), true);
  apiCallsUsed += 1;

  const reference = new Date();
  const matches: AnalysedMatch[] = [...todayFixtures, ...tomorrowFixtures]
    .map((fixture) => {
      const minutesUntilKickoff = Math.round(
        (new Date(fixture.kickoffUtc).getTime() - reference.getTime()) / 60000,
      );
      return {
        ...fixture,
        minutesUntilKickoff,
        status: computeStatus(minutesUntilKickoff, fixture.isTomorrow),
        blocked: isMatchBlocked(fixture.statusShort, minutesUntilKickoff),
      };
    })
    .sort(
      (a, b) =>
        new Date(a.kickoffUtc).getTime() - new Date(b.kickoffUtc).getTime(),
    );

  return { matches, apiCallsUsed };
}

export const STATUS_META: Record<
  MatchStatus,
  { label: string; emoji: string; className: string; canAnalyse: boolean }
> = {
  TOO_EARLY: {
    label: "TOO EARLY",
    emoji: "⛔",
    className: "text-slate",
    canAnalyse: false,
  },
  OPTIMAL: {
    label: "OPTIMAL",
    emoji: "✅",
    className: "text-accent-amber",
    canAnalyse: true,
  },
  VALID: {
    label: "VALID",
    emoji: "✅",
    className: "text-accent-amber",
    canAnalyse: true,
  },
  LATE: {
    label: "LATE",
    emoji: "⚠️",
    className: "text-slate",
    canAnalyse: false,
  },
  SKIP: {
    label: "SKIP",
    emoji: "🚫",
    className: "text-slate",
    canAnalyse: false,
  },
  TOMORROW: {
    label: "TOMORROW",
    emoji: "📅",
    className: "text-slate",
    canAnalyse: false,
  },
};
