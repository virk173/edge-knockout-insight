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
