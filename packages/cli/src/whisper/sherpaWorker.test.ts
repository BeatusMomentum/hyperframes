import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SHERPA_ERROR_PREFIX, SHERPA_RESULT_PREFIX } from "./parakeet.js";

const WORKER = fileURLToPath(new URL("./sherpaWorker.ts", import.meta.url));

// A stand-in sherpa-onnx-node: 3 s of steady sound. The whole window drops the first 2 s, as the real
// model did on a 61.91 s window; a padded window, or the gap alone for speech.wav, hears it all.
const FAKE_SHERPA = `
let path;
module.exports = {
  readWave(p) {
    path = p;
    if (path.endsWith("broken.wav")) throw new Error("Failed to read " + path);
    return { sampleRate: 100, samples: new Float32Array(300).fill(0.5) };
  },
  OfflineRecognizer: class {
    createStream() { return { acceptWaveform(w) { this.w = w; } }; }
    decode() {}
    getResult(stream) {
      const samples = stream.w.samples;
      if (samples[0] === 0) {
        return { tokens: [" ask", " not"], timestamps: [0.75, 1.5], durations: [0.4, 0.4] };
      }
      if (samples.length === 300) return { tokens: [" not"], timestamps: [2.08], durations: [0.4] };
      return path.endsWith("speech.wav")
        ? { tokens: [" ask", " not"], timestamps: [0.5, 2.08], durations: [0.4, 0.4] }
        : { tokens: [], timestamps: [], durations: [] };
    }
  },
};
`;

function runWorker(runtimeDir: string, wavPath: string) {
  const input = JSON.stringify({ wavPath, runtimeDir, config: {} });
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    execFile(
      process.execPath,
      ["--import", "tsx", WORKER],
      { env: { ...process.env, HYPERFRAMES_PARAKEET_INPUT: input } },
      (err, stdout, stderr) => resolve({ code: err ? (err.code as number) : 0, stdout, stderr }),
    );
  });
}

describe("sherpaWorker", () => {
  let root: string;
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function fakeRuntime(): string {
    root = mkdtempSync(join(tmpdir(), "hf-sherpa-worker-"));
    const pkg = join(root, "node_modules", "sherpa-onnx-node");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), '{"name":"sherpa-onnx-node","main":"index.js"}');
    writeFileSync(join(pkg, "index.js"), FAKE_SHERPA);
    return root;
  }

  function windowsOf(stdout: string) {
    const line = stdout.split("\n").find((l) => l.startsWith(SHERPA_RESULT_PREFIX))!;
    return JSON.parse(line.slice(SHERPA_RESULT_PREFIX.length));
  }

  it("decodes a gap that skipped loud audio on its own and splices in its new tokens", async () => {
    const { code, stdout } = await runWorker(fakeRuntime(), "speech.wav");
    expect(code).toBe(0);
    expect(windowsOf(stdout)).toEqual([
      { offset: 0, tokens: [" ask", " not"], timestamps: [0.5, 2.08], durations: [0.4, 0.4] },
    ]);
  });

  it("re-decodes the window with leading silence when the gap alone gives nothing", async () => {
    const { code, stdout } = await runWorker(fakeRuntime(), "hum.wav");
    expect(code).toBe(0);
    expect(windowsOf(stdout)).toEqual([
      { offset: 0, tokens: [" ask", " not"], timestamps: [0.25, 1], durations: [0.4, 0.4] },
    ]);
  });

  it("exits non-zero with one prefixed error line when it cannot read the audio", async () => {
    const { code, stderr } = await runWorker(fakeRuntime(), "broken.wav");
    expect(code).toBe(1);
    expect(stderr).toContain(`${SHERPA_ERROR_PREFIX}Failed to read broken.wav`);
  });

  it("names the missing runtime when sherpa-onnx-node is not installed", async () => {
    root = mkdtempSync(join(tmpdir(), "hf-sherpa-worker-"));
    const { code, stderr } = await runWorker(root, "speech.wav");
    expect(code).toBe(1);
    expect(stderr).toContain(`${SHERPA_ERROR_PREFIX}sherpa-onnx-node is not installed in ${root}`);
  });
});
