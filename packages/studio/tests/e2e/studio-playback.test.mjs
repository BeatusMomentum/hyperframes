import { describe, expect, it } from "vitest";
import { checkCeilings } from "./perf-ratchet.mjs";
import { playbackVerdict } from "./studio-playback.mjs";

const evidence = (headMs, baseMs, browser = "HeadlessChrome/153.0.8010.52") => ({
  browser,
  workCounts: { "playing.catalogElements": 176 },
  ab: { headCpuMedianMs: headMs, baseCpuMedianMs: baseMs, ratio: headMs / baseMs, maxRatio: 1.15 },
});

describe("playbackVerdict", () => {
  it("reports a 1.3x timing ratio as a warning and exits 0", () => {
    const verdict = playbackVerdict(evidence(6.5, 5), "153");
    expect(verdict.exitCode).toBe(0);
    expect(verdict.warning).toMatch(/reported, not failed/);
  });

  it("has nothing to say about timing within the limit", () => {
    expect(playbackVerdict(evidence(5.5, 5), "153")).toEqual({
      exitCode: 0,
      warning: null,
      error: null,
    });
  });

  it("exits 1 on a Chrome other than the ceilings', naming both", () => {
    const verdict = playbackVerdict(evidence(5, 5, "HeadlessChrome/154.0.1.2"), "153");
    expect(verdict.exitCode).toBe(1);
    expect(verdict.error).toMatch(/Chrome 154 .* Chrome 153/);
  });

  it("leaves a count rise to the ratchet, which fails it", () => {
    const rise = checkCeilings(
      { "playing.catalogElements": 176 },
      { "playing.catalogElements": 177 },
    );
    expect(rise.passed).toBe(false);
  });
});
