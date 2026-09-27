import { describe, expect, it } from "vitest";
import { resamplingDropsVfrDurations } from "./ffmpegVersion.js";

describe("resamplingDropsVfrDurations", () => {
  it.each([
    ["ffmpeg version 4.4.2-0ubuntu0.22.04.1 Copyright (c) 2000-2021", true],
    ["ffmpeg version 5.1.9-0+deb12u1 Copyright (c) 2000-2026", true],
    ["ffmpeg version n6.0.1 Copyright (c) 2000-2023", true],
    ["ffmpeg version 6.1.1-3ubuntu5 Copyright (c) 2000-2023", false],
    ["ffmpeg version n8.1.3-20260926 Copyright (c) 2000-2026", false],
    ["ffmpeg version N-117289-g0e9a3b2c1d Copyright (c) 2000-2026", false],
    ["", false],
  ])("%s", (versionOutput, expected) => {
    expect(resamplingDropsVfrDurations(versionOutput)).toBe(expected);
  });
});
