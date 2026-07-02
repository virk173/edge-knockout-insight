/**
 * bettingGlossary.ts — verified Stake.com market names and navigation.
 *
 * Built from Stake.com's actual market names and navigation. IMPORTANT:
 * On Stake.com the SGP feature is called "Same Game Multi" or accessed via
 * the "Bet Builder" tab inside a match — NOT "Same Game Parlay". These exact
 * Stake terms are used everywhere so generated stake_labels reflect the real
 * Stake interface rather than Claude's training knowledge.
 */

export const STAKE_MARKET_GLOSSARY = {
  MONEYLINE_3WAY: {
    stake_name: "Match Winner (1X2)",
    also_known_as: ["1X2", "Match Result", "Full Time Result", "3-way Moneyline"],
    stake_navigation: "Sports → Soccer → [Match] → Match Winner",
    selections: ["1 (Home Win)", "X (Draw)", "2 (Away Win)"],
    time_scope:
      "90 minutes + stoppage time only. Excludes extra time and penalties.",
    important_note:
      "If match goes to ET after a draw, the Draw option wins this market. A team win only pays if they win within 90 minutes.",
  },
  ASIAN_HANDICAP: {
    stake_name: "Asian Handicap",
    also_known_as: ["AH", "Handicap", "Asian Lines", "Spread"],
    stake_navigation: "Sports → Soccer → [Match] → Asian Handicap",
    selections: [
      "[Team] -0.5 (must win by 1+)",
      "[Team] -1 (must win by 2+, stake returned if win by 1)",
      "[Team] -1.5 (must win by 2+)",
      "[Team] +0.5 (win or draw pays)",
      "[Team] +1 (win or draw pays, stake returned if lose by 1)",
    ],
    time_scope: "90 minutes + stoppage time only. Excludes extra time.",
    important_note:
      "Eliminates the draw — only two outcomes. Quarter lines (-0.75, -1.25) split your stake across two lines for partial wins/losses.",
  },
  DRAW_NO_BET: {
    stake_name: "Draw No Bet",
    also_known_as: ["DNB", "2-way Moneyline"],
    stake_navigation: "Sports → Soccer → [Match] → Draw No Bet",
    selections: ["[Home Team] to Win", "[Away Team] to Win"],
    time_scope: "90 minutes + stoppage time only.",
    important_note:
      "If match ends in a draw after 90 minutes, stake is returned. Only two outcomes: home win or away win.",
  },
  DOUBLE_CHANCE: {
    stake_name: "Double Chance",
    also_known_as: ["DC"],
    stake_navigation: "Sports → Soccer → [Match] → Double Chance",
    selections: [
      "1X (Home Win or Draw)",
      "12 (Home Win or Away Win)",
      "X2 (Draw or Away Win)",
    ],
    time_scope: "90 minutes + stoppage time only.",
    important_note:
      "Covers two of three 1X2 outcomes. Lower odds than 1X2 but higher probability of winning.",
  },
  GOAL_TOTALS: {
    stake_name: "Total Goals (Over/Under)",
    also_known_as: ["Over/Under", "O/U Goals", "Total Goals", "Goal Line"],
    stake_navigation:
      "Sports → Soccer → [Match] → Total Goals → Over/Under [line]",
    selections: [
      "Over 0.5 Goals",
      "Over 1.5 Goals",
      "Over 2.5 Goals",
      "Over 3.5 Goals",
      "Under 0.5 Goals",
      "Under 1.5 Goals",
      "Under 2.5 Goals",
      "Under 3.5 Goals",
    ],
    time_scope:
      "90 minutes + stoppage time only. Goals scored in extra time DO NOT count.",
    important_note:
      "Over 2.5 wins if 3 or more goals are scored. Under 2.5 wins if 2 or fewer goals are scored.",
  },
  ASIAN_TOTAL: {
    stake_name: "Asian Total",
    also_known_as: ["Asian Lines Goals", "AH Total Goals"],
    stake_navigation: "Sports → Soccer → [Match] → Asian Total → [line]",
    selections: [
      "Over 1.75",
      "Over 2.25",
      "Over 2.75",
      "Over 3.25",
      "Under 1.75",
      "Under 2.25",
      "Under 2.75",
      "Under 3.25",
    ],
    time_scope: "90 minutes + stoppage time only.",
    important_note:
      "NOT the same as Exact Goals or Correct Score. Uses quarter-goal lines for partial wins/losses. Over 2.25 = half win if exactly 2 goals, full win if 3+. Look under Asian Total section, not Total Goals.",
  },
  BTTS: {
    stake_name: "Both Teams to Score",
    also_known_as: ["BTTS", "GG/NG", "Both Teams Score", "Goal/Goal"],
    stake_navigation: "Sports → Soccer → [Match] → Both Teams to Score",
    selections: [
      "Yes (both teams score)",
      "No (at least one team fails to score)",
    ],
    time_scope: "90 minutes + stoppage time only.",
    important_note:
      "Yes wins only if BOTH teams score at least one goal each. No wins if either team finishes with 0 goals.",
  },
  CORNERS_TOTALS: {
    stake_name: "Total Corners",
    also_known_as: ["Corner Kicks O/U", "Corners Over/Under", "Total Corner Kicks"],
    stake_navigation:
      "Sports → Soccer → [Match] → Corners → Total Corners Over/Under [line]",
    selections: [
      "Over 8.5 Corners",
      "Over 9.5 Corners",
      "Over 10.5 Corners",
      "Under 8.5 Corners",
      "Under 9.5 Corners",
      "Under 10.5 Corners",
    ],
    time_scope:
      "90 minutes + stoppage time only. Corners awarded in extra time DO NOT count.",
    important_note:
      "Counts total corner kicks taken by both teams combined. A corner is only counted when actually taken, not just awarded.",
  },
  CARDS_TOTALS: {
    stake_name: "Total Cards",
    also_known_as: ["Bookings O/U", "Yellow Cards O/U", "Cards Over/Under"],
    stake_navigation:
      "Sports → Soccer → [Match] → Cards → Total Cards Over/Under [line]",
    selections: [
      "Over 2.5 Cards",
      "Over 3.5 Cards",
      "Over 4.5 Cards",
      "Under 2.5 Cards",
      "Under 3.5 Cards",
      "Under 4.5 Cards",
    ],
    time_scope: "90 minutes + stoppage time only.",
    important_note:
      "On Stake: yellow cards count as 1, red cards count as 2 (yellow+red for a straight red). Always verify card counting rules before placing — some markets count yellow cards only.",
  },
  MATCH_EXTRA_TIME: {
    stake_name: "Will Match Go to Extra Time?",
    also_known_as: ["Extra Time Yes/No", "ET Yes", "Goes to ET", "Match Goes to AET"],
    stake_navigation:
      "Sports → Soccer → [Match] → Match Specials → Will the Match Go to Extra Time",
    selections: [
      "Yes (match level after 90 mins, goes to 30 min ET)",
      "No (winner decided in 90 mins)",
    ],
    time_scope: "Settled after 90 minutes + stoppage time.",
    important_note:
      "Only available in knockout competitions where ET is possible. Base rate ~28% of knockout matches go to ET. Wins if score is level after 90 mins and ET is played.",
  },
  MATCH_PENALTIES: {
    stake_name: "Will Match Go to Penalties?",
    also_known_as: ["Penalty Shootout Yes/No", "Pens Yes", "Goes to Pens"],
    stake_navigation:
      "Sports → Soccer → [Match] → Match Specials → Will the Match Go to Penalties",
    selections: [
      "Yes (goes to penalty shootout)",
      "No (decided before shootout)",
    ],
    time_scope: "Settled after full match including extra time.",
    important_note:
      "Only wins if match goes to a penalty shootout AFTER extra time. Base rate ~11% of all knockout matches. Must pass through ET first.",
  },
  TEAM_TO_QUALIFY: {
    stake_name: "To Qualify / To Advance",
    also_known_as: [
      "Team to Advance",
      "Match Winner incl ET & Pens",
      "Outright Match Winner",
      "To Progress",
    ],
    stake_navigation:
      "Sports → Soccer → [Match] → Match Winner → [Team] to Qualify",
    selections: ["[Home Team] to Qualify", "[Away Team] to Qualify"],
    time_scope:
      "Full match including extra time AND penalties if required.",
    important_note:
      "This is NOT the same as 1X2. Wins regardless of how the team advances — 90 mins, ET, or pens. Significantly higher probability than 1X2 Win for favorites in knockouts.",
  },
  SAME_GAME_MULTI: {
    stake_name: "Same Game Multi / Bet Builder",
    also_known_as: [
      "SGM",
      "Bet Builder",
      "Same Game Parlay",
      "SGP",
      "Accumulator",
      "Multi",
    ],
    stake_navigation: "Sports → Soccer → [Match] → Bet Builder tab",
    selections: [
      "Add 3+ selections from any available markets within the same match",
    ],
    time_scope: "Each leg follows its own market time scope.",
    important_note:
      "On Stake the feature is labeled 'Bet Builder' tab inside the match. Minimum 3 legs required. All legs must win for bet to pay. Combined odds are lower than multiplying individual odds due to bookmaker hold (SGM tax). Use Bet Code feature to share or replicate a slip.",
  },
} as const;

export type StakeMarketType = keyof typeof STAKE_MARKET_GLOSSARY;

// ─────────────────────────────────────────────────────────────
// Helper functions
// ─────────────────────────────────────────────────────────────
export const getMarketGlossary = (marketType: StakeMarketType) =>
  STAKE_MARKET_GLOSSARY[marketType] ?? null;

export const generateStakeLabel = (
  marketType: StakeMarketType,
  selection: string,
  homeTeam: string,
  awayTeam: string,
): string => {
  const g = getMarketGlossary(marketType);
  if (!g) {
    return (
      `Navigate: Sports → Soccer → ${homeTeam} vs ${awayTeam}\n` +
      `Select: ${selection}\n` +
      `Time scope: 90 minutes only`
    );
  }
  const nav = g.stake_navigation.replace(
    "[Match]",
    `${homeTeam} vs ${awayTeam}`,
  );
  return (
    `Navigate: ${nav}\n` +
    `Select: ${selection}\n` +
    `Time scope: ${g.time_scope}\n` +
    (g.important_note ? `⚠️ Note: ${g.important_note}` : "")
  );
};

// Map from Claude's free-text market names to glossary keys for automatic
// stake label generation.
export const MARKET_NAME_MAP: Record<string, StakeMarketType> = {
  // Match result variants
  "1x2": "MONEYLINE_3WAY",
  "match winner": "MONEYLINE_3WAY",
  "match result": "MONEYLINE_3WAY",
  moneyline: "MONEYLINE_3WAY",
  "full time result": "MONEYLINE_3WAY",
  "moneyline (3-way)": "MONEYLINE_3WAY",
  // Asian handicap variants
  "asian handicap": "ASIAN_HANDICAP",
  handicap: "ASIAN_HANDICAP",
  "asian lines": "ASIAN_HANDICAP",
  spread: "ASIAN_HANDICAP",
  // Draw no bet
  "draw no bet": "DRAW_NO_BET",
  dnb: "DRAW_NO_BET",
  // Double chance
  "double chance": "DOUBLE_CHANCE",
  dc: "DOUBLE_CHANCE",
  // Goals
  "goal totals": "GOAL_TOTALS",
  "total goals": "GOAL_TOTALS",
  "over/under": "GOAL_TOTALS",
  "over/under goals": "GOAL_TOTALS",
  "goals over/under": "GOAL_TOTALS",
  // Asian total
  "asian total": "ASIAN_TOTAL",
  "asian total goals": "ASIAN_TOTAL",
  "asian lines goals": "ASIAN_TOTAL",
  // BTTS
  btts: "BTTS",
  "both teams to score": "BTTS",
  "both teams score": "BTTS",
  "gg/ng": "BTTS",
  // Corners
  "corners totals": "CORNERS_TOTALS",
  "total corners": "CORNERS_TOTALS",
  "corners over/under": "CORNERS_TOTALS",
  "corner kicks": "CORNERS_TOTALS",
  // Cards
  "cards totals": "CARDS_TOTALS",
  "total cards": "CARDS_TOTALS",
  "cards over/under": "CARDS_TOTALS",
  bookings: "CARDS_TOTALS",
  "yellow cards": "CARDS_TOTALS",
  // Knockout markets
  "extra time": "MATCH_EXTRA_TIME",
  "match goes to et": "MATCH_EXTRA_TIME",
  "et yes": "MATCH_EXTRA_TIME",
  penalties: "MATCH_PENALTIES",
  "penalty shootout": "MATCH_PENALTIES",
  "pens yes": "MATCH_PENALTIES",
  "team to qualify": "TEAM_TO_QUALIFY",
  "to qualify": "TEAM_TO_QUALIFY",
  "to advance": "TEAM_TO_QUALIFY",
  "team to advance": "TEAM_TO_QUALIFY",
  // SGM
  "same game multi": "SAME_GAME_MULTI",
  "bet builder": "SAME_GAME_MULTI",
  sgm: "SAME_GAME_MULTI",
  sgp: "SAME_GAME_MULTI",
  "same game parlay": "SAME_GAME_MULTI",
  accumulator: "SAME_GAME_MULTI",
};

export const resolveMarketType = (
  claudeMarketName: string,
): StakeMarketType | null => {
  if (!claudeMarketName) return null;
  const normalized = claudeMarketName.toLowerCase().trim();

  // FIX 3 — progressive matching. Exact-match alone fails on Claude's own
  // few-shot names like "Goal Totals (Over/Under)" or "Total Goals Over/Under
  // 2.5". Try exact, then parenthetical-stripped, then the longest map key
  // contained anywhere in the name.

  // 1) exact
  if (MARKET_NAME_MAP[normalized]) return MARKET_NAME_MAP[normalized];

  // 2) strip parentheticals + collapse whitespace
  const stripped = normalized
    .replace(/\s*\(.*?\)\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (stripped && MARKET_NAME_MAP[stripped]) return MARKET_NAME_MAP[stripped];

  // 3) longest map key CONTAINED in the (stripped) name
  const haystack = stripped || normalized;
  let best: { key: string; type: StakeMarketType } | null = null;
  for (const key of Object.keys(MARKET_NAME_MAP)) {
    if (haystack.includes(key) && (!best || key.length > best.key.length)) {
      best = { key, type: MARKET_NAME_MAP[key] };
    }
  }
  return best ? best.type : null;
};
