import { describe, it, expect } from "vitest";
import { formatDataForClaude } from "./analyse";

// OPT 5 — C6's bench array is removed and replaced with notable_bench_changes:
// C5 doubtful/questionable players who did NOT make today's confirmed starting
// XI. (The literal spec asked for a comparison against the PREVIOUS match's
// starting XI via C4 — but C4 only ever carries scorelines, never lineup data,
// so that comparison is not implementable without new data fetching. Per
// direction, this implements the C5-vs-C6 signal instead.)

const rawLineup = {
  confirmed: true,
  source: "TheStatsAPI",
  home: {
    team: { name: "France" },
    formation: "4-3-3",
    starting_xi: [
      { player: { name: "Mbappe", position: "FW", jersey_number: 10 } },
      { player: { name: "Griezmann", position: "MF", jersey_number: 7 } },
    ],
    substitutes: [
      { player: { name: "Coman", position: "FW", jersey_number: 11 } },
      { player: { name: "Tchouameni", position: "MF", jersey_number: 8 } },
    ],
  },
  away: {
    team: { name: "Brazil" },
    formation: "4-2-3-1",
    starting_xi: [{ player: { name: "Vinicius Jr", position: "FW", jersey_number: 20 } }],
    substitutes: [{ player: { name: "Rodrygo", position: "FW", jersey_number: 19 } }],
  },
};

function c6Block(callResults: Record<string, unknown>) {
  const full = formatDataForClaude(callResults as any);
  const block = full.match(/\[CALL 6[\s\S]*?\[END CALL 6\]/)?.[0] ?? "";
  const lines = block.split("\n");
  return JSON.parse(lines.slice(1, -1).join("\n"));
}

describe("OPT 5 — C6 bench list removed, notable_bench_changes added", () => {
  it("bench (substitutes) array is absent from the compacted output", () => {
    const out = c6Block({ "6": { status: "SUCCESS", data: rawLineup } });
    expect(out.home).not.toHaveProperty("substitutes");
    expect(out.away).not.toHaveProperty("substitutes");
    expect(out.home.starting_xi).toHaveLength(2);
    expect(out.home).toHaveProperty("notable_bench_changes");
  });

  it("a C5 doubtful player ON THE BENCH appears in notable_bench_changes, NOT doubtful_absent_from_xi (they made the squad)", () => {
    const rawInjuries = [
      {
        player: { name: "Coman", type: "Questionable" },
        team: { name: "France" },
      },
    ];
    const out = c6Block({
      "6": { status: "SUCCESS", data: rawLineup },
      "5": { status: "SUCCESS", data: rawInjuries },
    });
    expect(out.home.notable_bench_changes).toEqual(["Coman"]);
    expect(out.home.doubtful_absent_from_xi).toEqual([]);
    expect(out.away.notable_bench_changes).toEqual([]);
  });

  it("a C5 doubtful player in NEITHER the XI NOR the bench goes to doubtful_absent_from_xi (real absence candidate)", () => {
    const rawInjuries = [
      { player: { name: "Kante", type: "Doubtful" }, team: { name: "France" } },
    ];
    const out = c6Block({
      "6": { status: "SUCCESS", data: rawLineup },
      "5": { status: "SUCCESS", data: rawInjuries },
    });
    expect(out.home.doubtful_absent_from_xi).toEqual(["Kante"]);
    expect(out.home.notable_bench_changes).toEqual([]);
  });

  it("a C5 doubtful player who DID start appears in neither list (cleared to play)", () => {
    const rawInjuries = [
      { player: { name: "Mbappe", type: "Doubtful" }, team: { name: "France" } },
    ];
    const out = c6Block({
      "6": { status: "SUCCESS", data: rawLineup },
      "5": { status: "SUCCESS", data: rawInjuries },
    });
    expect(out.home.notable_bench_changes).toEqual([]);
    expect(out.home.doubtful_absent_from_xi).toEqual([]);
  });

  it("a confirmed-out (non-doubtful) C5 entry is not treated as a bench change", () => {
    const rawInjuries = [
      { player: { name: "Coman", type: "Missing Fixture" }, team: { name: "France" } },
    ];
    const out = c6Block({
      "6": { status: "SUCCESS", data: rawLineup },
      "5": { status: "SUCCESS", data: rawInjuries },
    });
    expect(out.home.notable_bench_changes).toEqual([]);
  });

  it("no C5 data available -> empty array, never guessed, no error", () => {
    const out = c6Block({ "6": { status: "SUCCESS", data: rawLineup } });
    expect(out.home.notable_bench_changes).toEqual([]);
    expect(out.away.notable_bench_changes).toEqual([]);
  });
});
