import { describe, it, expect } from "vitest";
import { extractStakeMarkets } from "./analyse";

// Mimics the API-Football /odds (Stake) payload shape consumed by
// extractStakeMarkets: response[] -> bookmakers[] -> bets[] -> values[].
const rawOddsPayload = [
  {
    bookmakers: [
      {
        name: "Stake",
        bets: [
          {
            name: "Match Winner",
            values: [
              { value: "Home", odd: "1.80" },
              { value: "Draw", odd: "3.50" },
              { value: "Away", odd: "4.20" },
            ],
          },
          {
            name: "Goals Over/Under",
            values: [
              { value: "Over 2.5", odd: "1.95" },
              { value: "Under 2.5", odd: "1.90" },
            ],
          },
          {
            name: "Corners Over/Under",
            values: [
              { value: "Over 8.5", odd: "1.70" },
              { value: "Over 9.5", odd: "2.05" },
              { value: "Under 9.5", odd: "1.78" },
              { value: "Over 10.5", odd: "2.60" },
            ],
          },
          {
            name: "Cards Over/Under",
            values: [
              { value: "Over 2.5", odd: "1.60" },
              { value: "Over 3.5", odd: "2.30" },
              { value: "Under 3.5", odd: "1.62" },
              { value: "Over 4.5", odd: "3.40" },
            ],
          },
        ],
      },
    ],
  },
];

describe("extractStakeMarkets — cards & corners lines", () => {
  it("extracts the cards market (2.5/3.5/4.5) so a cards bet can be proposed", () => {
    const res = extractStakeMarkets(rawOddsPayload);
    const cards = res?.markets["Cards Over/Under"];
    expect(cards).toBeDefined();
    const over35 = cards?.find(
      (v) => v.value.toLowerCase().includes("over") && v.value.includes("3.5"),
    );
    expect(over35?.odd).toBe("2.30");
    // 2.5 and 4.5 also captured when present at no extra cost.
    expect(cards?.some((v) => v.value.includes("2.5"))).toBe(true);
    expect(cards?.some((v) => v.value.includes("4.5"))).toBe(true);
  });

  it("extracts corners 8.5/9.5/10.5, not just 9.5", () => {
    const res = extractStakeMarkets(rawOddsPayload);
    const corners = res?.markets["Corners Over/Under"];
    expect(corners).toBeDefined();
    expect(corners?.some((v) => v.value.includes("8.5"))).toBe(true);
    expect(corners?.some((v) => v.value.includes("9.5"))).toBe(true);
    expect(corners?.some((v) => v.value.includes("10.5"))).toBe(true);
  });

  it("leaves existing markets (1X2, O/U 2.5, corners primary line) intact", () => {
    const res = extractStakeMarkets(rawOddsPayload);
    expect(res?.bookmaker).toBe("Stake");
    expect(res?.markets["1X2 (Match Winner)"]?.length).toBe(3);
    const over25 = res?.markets["Over/Under 2.5 Goals"]?.find((v) =>
      v.value.toLowerCase().includes("over"),
    );
    expect(over25?.odd).toBe("1.95");
  });
});
