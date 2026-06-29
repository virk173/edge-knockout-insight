// API-Football fixtures fetching + status logic (client-side, uses VITE key).

import { incrementApiCallCount } from "./apiCounter";

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

const API_BASE = "https://v3.football.api-sports.io/fixtures";

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

interface ApiFixtureResponse {
  errors?: unknown;
  response?: Array<{
    fixture: { id: number; date: string; referee?: string | null };
    league?: { round?: string | null };
    teams: {
      home: { id: number; name: string };
      away: { id: number; name: string };
    };
  }>;
}

function normaliseErrors(errors: unknown): string | null {
  if (!errors) return null;
  if (Array.isArray(errors)) {
    return errors.length ? errors.join(", ") : null;
  }
  if (typeof errors === "object") {
    const values = Object.values(errors as Record<string, unknown>);
    return values.length ? values.map(String).join(", ") : null;
  }
  if (typeof errors === "string") {
    return errors.trim() ? errors : null;
  }
  return null;
}

async function fetchFixturesForDate(
  date: string,
  apiKey: string,
  isTomorrow: boolean,
): Promise<Fixture[]> {
  const url = `${API_BASE}?league=1&season=2026&date=${date}`;
  const res = await fetch(url, {
    headers: { "x-apisports-key": apiKey },
  });

  if (!res.ok) {
    throw new Error(`API returned ${res.status} ${res.statusText}`);
  }

  const json = (await res.json()) as ApiFixtureResponse;
  const apiError = normaliseErrors(json.errors);
  if (apiError) {
    throw new Error(apiError);
  }

  return (json.response ?? []).map((item) => ({
    id: item.fixture.id,
    home: item.teams.home.name,
    away: item.teams.away.name,
    kickoffUtc: item.fixture.date,
    isTomorrow,
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
  const apiKey = import.meta.env.VITE_APIFOOTBALL_KEY as string | undefined;
  if (!apiKey) {
    throw new Error(
      "Missing VITE_APIFOOTBALL_KEY. Add it to your environment to run analysis.",
    );
  }

  const now = new Date();
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  let apiCallsUsed = 0;
  const todayFixtures = await fetchFixturesForDate(isoDate(now), apiKey, false);
  apiCallsUsed += 1;
  const tomorrowFixtures = await fetchFixturesForDate(
    isoDate(tomorrow),
    apiKey,
    true,
  );
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
