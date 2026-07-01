import { describe, it, expect } from "vitest";
import { buildCallPanelSummary } from "@/lib/analyse";

const mk = (status: string, cached = false) => ({ key: "", label: "", status, cached, fetchedAt: Date.now() } as any);

describe("readiness gate", () => {
  it("ready when mandatory ran, odds EMPTY", () => {
    const cr: any = { C1: mk("SUCCESS"), S0: mk("SUCCESS"), "2A": mk("SUCCESS"), "2B": mk("SUCCESS"), "9": mk("EMPTY"), "3": mk("EMPTY"), "5": mk("FAILED") };
    const s = buildCallPanelSummary(cr);
    expect(s.mandatoryReady).toBe(true);
    expect(s.emptyMandatory).toContain("C9A");
    expect(s.failedOptional).toContain("C5");
  });
  it("blocks when mandatory team stats never ran", () => {
    const cr: any = { C1: mk("SUCCESS"), S0: mk("SUCCESS"), "9": mk("EMPTY") };
    const s = buildCallPanelSummary(cr);
    expect(s.mandatoryReady).toBe(false);
    expect(s.notReadyMandatory).toEqual(expect.arrayContaining(["S2A", "S2B"]));
  });
  it("blocks on C1 mismatch", () => {
    const cr: any = { C1: mk("FAILED"), S0: mk("SUCCESS"), "2A": mk("SUCCESS"), "2B": mk("SUCCESS"), "9": mk("SUCCESS") };
    const s = buildCallPanelSummary(cr);
    expect(s.mandatoryReady).toBe(false);
    expect(s.notReadyMandatory).toContain("C1");
  });
});
