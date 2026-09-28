export interface ToneMapSourceColour {
  colorSpace?: string;
  colorPrimaries?: string;
  colorTransfer?: string;
}

export interface FirstFrameColour extends ToneMapSourceColour {
  /** HDR10 peak in 100-nit units: MaxCLL, else the mastering display's maximum (tonemap's own rule). */
  peak?: number;
}

function known(value: string | undefined): string | undefined {
  return value && value !== "unknown" && value !== "reserved" ? value : undefined;
}

/**
 * HDR to SDR BT.709 with zscale and hable. zscale reads each frame's own tags, so only those the
 * first frame lacks are set: from ffprobe, which may see the container's, else BT.2020. The peak
 * is passed explicitly because zscale strips HDR10 light levels from ffmpeg 8.0 on.
 */
export function hdrToSdrToneMapFilter(
  probed: ToneMapSourceColour,
  firstFrame: FirstFrameColour,
): string {
  const fill = (key: keyof ToneMapSourceColour, fallback?: string) =>
    known(firstFrame[key]) ? undefined : (known(probed[key]) ?? fallback);
  const tags = [
    ["colorspace", fill("colorSpace", "bt2020nc")],
    ["color_primaries", fill("colorPrimaries", "bt2020")],
    ["color_trc", fill("colorTransfer")],
  ].filter(([, value]) => value);
  const setTags = tags.length ? `setparams=${tags.map((tag) => tag.join("=")).join(":")},` : "";
  const peak = firstFrame.peak ? `:peak=${firstFrame.peak}` : "";
  return `${setTags}zscale=t=linear:npl=100,tonemap=hable:desat=0${peak},zscale=p=bt709:t=bt709:m=bt709:r=tv`;
}

/** ffmpeg args printing the first shown frame's tags; ffprobe's packet-bounded reads miss edit-list pre-roll. */
export function firstFrameColourArgs(videoPath: string): string[] {
  return [
    ...["-hide_banner", "-nostats", "-i", videoPath, "-map", "0:v:0", "-frames:v", "1"],
    ...["-vf", "showinfo", "-f", "null", "-"],
  ];
}

export function parseFirstFrameColour(stderr: string): FirstFrameColour {
  const tags = / color_space:(\S+) color_primaries:(\S+) color_trc:(\S+)/.exec(stderr);
  const nits = (pattern: RegExp) => Number(pattern.exec(stderr)?.[1] ?? 0);
  const peakNits =
    nits(/side data - Content light level metadata: MaxCLL=(\d+)/) ||
    nits(/side data - Mastering display metadata:[^\n]*max_luminance=([\d.]+)/);
  return {
    ...(tags ? { colorSpace: tags[1], colorPrimaries: tags[2], colorTransfer: tags[3] } : {}),
    ...(peakNits > 0 ? { peak: peakNits / 100 } : {}),
  };
}
