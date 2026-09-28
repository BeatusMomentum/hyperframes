import { describe, expect, it } from "vitest";
import { hdrToSdrToneMapFilter, parseFirstFrameColour } from "./hdrToneMap";

const PQ = { colorSpace: "bt2020nc", colorPrimaries: "bt2020", colorTransfer: "smpte2084" };
const TONE_MAP =
  "zscale=t=linear:npl=100,tonemap=hable:desat=0,zscale=p=bt709:t=bt709:m=bt709:r=tv";

describe("hdrToSdrToneMapFilter", () => {
  it("leaves every frame its own tags when the first frame carries them all", () => {
    expect(hdrToSdrToneMapFilter(PQ, PQ)).toBe(TONE_MAP);
  });

  it("sets the probed tags the first frame lacks", () => {
    expect(hdrToSdrToneMapFilter(PQ, {})).toBe(
      `setparams=colorspace=bt2020nc:color_primaries=bt2020:color_trc=smpte2084,${TONE_MAP}`,
    );
    expect(hdrToSdrToneMapFilter(PQ, { colorTransfer: "arib-std-b67" })).toBe(
      `setparams=colorspace=bt2020nc:color_primaries=bt2020,${TONE_MAP}`,
    );
  });

  it("treats a missing matrix or primaries as BT.2020 and leaves an unknown transfer to the frames", () => {
    expect(
      hdrToSdrToneMapFilter(
        { colorSpace: "unknown", colorTransfer: "arib-std-b67" },
        { colorSpace: "unknown", colorPrimaries: "unknown", colorTransfer: "arib-std-b67" },
      ),
    ).toBe(`setparams=colorspace=bt2020nc:color_primaries=bt2020,${TONE_MAP}`);
    expect(hdrToSdrToneMapFilter({ colorPrimaries: "reserved" }, {})).toBe(
      `setparams=colorspace=bt2020nc:color_primaries=bt2020,${TONE_MAP}`,
    );
  });

  it("passes the first frame's HDR10 peak to tonemap", () => {
    expect(hdrToSdrToneMapFilter(PQ, { ...PQ, peak: 40 })).toBe(
      TONE_MAP.replace("desat=0", "desat=0:peak=40"),
    );
  });
});

describe("parseFirstFrameColour", () => {
  // showinfo lines as ffmpeg 7 and 8 print them; 8 adds the stream's side data, indented, first.
  const frame = (maxCll: number, maxLuminance: number) =>
    [
      "    Side data:",
      "      Content light level metadata: MaxCLL=9999, MaxFALL=400",
      "[Parsed_showinfo_0 @ 0x1] n:   0 pts:      0 pts_time:0",
      `[Parsed_showinfo_0 @ 0x1]   side data - Mastering display metadata: has_primaries:1 has_luminance:1 min_luminance=0.005000, max_luminance=${maxLuminance}.000000`,
      `[Parsed_showinfo_0 @ 0x1]   side data - Content light level metadata: MaxCLL=${maxCll}, MaxFALL=400`,
      "[Parsed_showinfo_0 @ 0x1]   color_range:tv color_space:bt2020nc color_primaries:bt2020 color_trc:smpte2084",
    ].join("\n");

  it("reads the peak from the frame's MaxCLL, else its mastering display's maximum", () => {
    expect(parseFirstFrameColour(frame(4000, 1000))).toEqual({ ...PQ, peak: 40 });
    expect(parseFirstFrameColour(frame(0, 1000))).toEqual({ ...PQ, peak: 10 });
  });

  it("leaves the peak to tonemap when the frame carries no light levels", () => {
    const hlg =
      "[Parsed_showinfo_0 @ 0x1]   color_range:tv color_space:bt2020nc color_primaries:bt2020 color_trc:arib-std-b67";
    expect(parseFirstFrameColour(hlg)).toEqual({ ...PQ, colorTransfer: "arib-std-b67" });
  });
});
