import { describe, it, expect } from "vitest";
import { validateInput } from "./api-proxy.functions";

// EDGE-FIX tier 0 — the old prefix check (`url.startsWith(base)`) passed
// attacker hostnames like "v3.football.api-sports.io.evil.com", letting the
// server attach the API key header to a request bound for an attacker host.
// These tests lock in the exact-origin allowlist.

describe("api-proxy validateInput — origin allowlist", () => {
  it("accepts genuine API-Football URLs", () => {
    expect(() =>
      validateInput({
        provider: "apifootball",
        url: "https://v3.football.api-sports.io/odds?fixture=1&bookmaker=4",
      }),
    ).not.toThrow();
  });

  it("accepts genuine TheStatsAPI URLs under /api", () => {
    expect(() =>
      validateInput({
        provider: "statsapi",
        url: "https://api.thestatsapi.com/api/football/matches?date_from=2026-07-03",
      }),
    ).not.toThrow();
  });

  it("REJECTS the prefix-bypass hostname (api-sports.io.evil.com)", () => {
    expect(() =>
      validateInput({
        provider: "apifootball",
        url: "https://v3.football.api-sports.io.evil.com/odds?fixture=1",
      }),
    ).toThrow();
  });

  it("REJECTS the prefix-bypass hostname for statsapi", () => {
    expect(() =>
      validateInput({
        provider: "statsapi",
        url: "https://api.thestatsapi.com.evil.com/api/football/matches",
      }),
    ).toThrow();
  });

  it("REJECTS userinfo-style bypass (origin@evil.com)", () => {
    expect(() =>
      validateInput({
        provider: "apifootball",
        url: "https://v3.football.api-sports.io@evil.com/odds",
      }),
    ).toThrow();
  });

  it("REJECTS a statsapi URL outside the /api path prefix", () => {
    expect(() =>
      validateInput({
        provider: "statsapi",
        url: "https://api.thestatsapi.com/other/endpoint",
      }),
    ).toThrow();
  });

  it("REJECTS unparseable URLs and wrong providers", () => {
    expect(() => validateInput({ provider: "apifootball", url: "not a url" })).toThrow();
    expect(() =>
      validateInput({ provider: "other", url: "https://v3.football.api-sports.io/x" }),
    ).toThrow();
  });
});
