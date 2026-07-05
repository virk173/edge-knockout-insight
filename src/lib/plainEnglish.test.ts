import { describe, it, expect } from "vitest";
import { dejargonize, analystNoteBullets } from "@/lib/plainEnglish";

// The exact analyst_note from the 2026-07-05 Brazil vs Norway live run — the
// wall of prose that motivated the bullet renderer.
const LIVE_NOTE =
  "Brazil enters as moderate favourite (50pct model) against a Norway side that has scored freely (8 goals in 3 games) but also leaked badly (7 conceded) — this asymmetry drives the Over 2.5 Goals and BTTS signals despite a 3-signal CONFLICT on total goals expectation (APP-Poisson 3.67 vs R16 historical base rate 2.2). H2H gate failed (only 1 competitive meeting on record with no score data), so D6 weight was zeroed and redistributed to D1. Lineup data required API-Football fallback after a PROPAGATING state, and C6B returned EMPTY, meaning Raphinha's and Paquetá's injury impact could not be gap-scored with real data — both are treated as confirmed absences per C5 despite a bench-list inconsistency for Raphinha that could not be resolved. Given the Round of 16 match (post-2022-format round, structurally comparable to prior tournaments), Rule 33's staleness caveat does not apply. Referee Ismail Elfath's HIGH strictness (80) is a career-average signal on a Round of 16 fixture rather than Quarter-Finals or later, so Rule 32's confound caveat is not triggered here.";

describe("dejargonize", () => {
  it("translates internal codenames to plain phrases, keeping the code", () => {
    const out = dejargonize(LIVE_NOTE);
    expect(out).toContain("the player-stats feed (C6B)");
    expect(out).toContain("the injury feed (C5)");
    expect(out).toContain("head-to-head (D6)");
    expect(out).toContain("form (D1)");
    expect(out).toContain("head-to-head history requirement failed");
    expect(out).toContain("still-publishing (PROPAGATING) state");
    expect(out).toContain("returned no data (EMPTY)");
    expect(out).toContain("the app's goals model 3.67");
    expect(out).toContain("Round-of-16 historical base rate");
    expect(out).toContain("Both Teams To Score");
  });

  it("converts pct to % and removes gap-scoring jargon", () => {
    const out = dejargonize(LIVE_NOTE);
    expect(out).toContain("50% model");
    expect(out).not.toMatch(/\bpct\b/);
    expect(out).not.toContain("gap-scored");
  });

  it("C6B is never partially matched by the C6 rule", () => {
    expect(dejargonize("C6B and C6 differ")).toBe(
      "the player-stats feed (C6B) and the lineup feed (C6) differ",
    );
  });
});

describe("analystNoteBullets", () => {
  const bullets = analystNoteBullets(LIVE_NOTE);

  it("splits the note into multiple bullets", () => {
    expect(bullets.length).toBeGreaterThanOrEqual(5);
  });

  it("splits sentences whose start gets lowercased by de-jargonizing", () => {
    // "H2H gate failed…" begins a raw sentence; its translation starts
    // lowercase, so splitting must happen BEFORE translation.
    expect(bullets.some((b) => b.startsWith("Head-to-head history requirement failed"))).toBe(true);
  });

  it("never splits on a decimal point like 'Over 2.5 Goals'", () => {
    expect(bullets.some((b) => b.includes("Over 2.5 Goals"))).toBe(true);
    // No bullet may end mid-number ("…Over 2." would mean a bad split).
    expect(bullets.every((b) => !/\d\.$/.test(b) || /\.\s*$/.test(b))).toBe(true);
    expect(bullets.some((b) => b.startsWith("5 Goals"))).toBe(false);
  });

  it("breaks overlong sentences at em-dashes", () => {
    // The first live sentence is ~330 chars; it must arrive as 2 bullets.
    expect(bullets[0]).toContain("Brazil enters as moderate favourite");
    expect(bullets[0]!.length).toBeLessThan(250);
    expect(bullets.some((b) => b.startsWith("This asymmetry drives"))).toBe(true);
  });

  it("capitalizes every bullet", () => {
    for (const b of bullets) {
      expect(b.charAt(0)).toBe(b.charAt(0).toUpperCase());
    }
  });

  it("handles a short single-sentence note", () => {
    expect(analystNoteBullets("Straightforward match.")).toEqual(["Straightforward match."]);
  });
});
