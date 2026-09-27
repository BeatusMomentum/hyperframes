import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getFfmpegBinary } from "./ffmpegBinaries.js";

let cachedVersionOutput: Promise<string> | null = null;

/**
 * ffmpeg before 6.1 ignores frame durations in CFR resampling once a filter is set, so a VFR
 * window that ends on a still loses its last frames. Unversioned (git) builds count as new.
 */
export function resamplingDropsVfrDurations(versionOutput: string): boolean {
  const match = /^ffmpeg version n?(\d+)\.(\d+)/m.exec(versionOutput);
  if (!match) return false;
  const major = Number(match[1]);
  return major < 6 || (major === 6 && Number(match[2]) < 1);
}

/** {@link resamplingDropsVfrDurations} for the resident ffmpeg, probed once per process. */
export async function residentFfmpegDropsVfrDurations(): Promise<boolean> {
  cachedVersionOutput ??= promisify(execFile)(getFfmpegBinary(), ["-version"], {
    timeout: 5_000,
    windowsHide: true,
  })
    .then(({ stdout }) => stdout)
    .catch(() => {
      cachedVersionOutput = null;
      return "";
    });
  return resamplingDropsVfrDurations(await cachedVersionOutput);
}
