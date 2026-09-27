import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SHERPA_ERROR_PREFIX, SHERPA_RESULT_PREFIX } from "./parakeet.js";

const WORKER = fileURLToPath(new URL("./sherpaWorker.ts", import.meta.url));

// A stand-in sherpa-onnx-node: 3 s of steady sound. Unpadded, the recognizer "drops" the first
// 2 s the way the real model did on a 61.91 s window; with leading silence it hears everything.
const FAKE_SHERPA = `
module.exports = {
  readWave(path) {
    if (path.endsWith("broken.wav")) throw new Error("Failed to read " + path);
    return { sampleRate: 100, samples: new Float32Array(300).fill(0.5) };
  },
  OfflineRecognizer: class {
    createStream() { return { acceptWaveform(w) { this.w = w; } }; }
    decode() {}
    getResult(stream) {
      const padded = stream.w.samples[0] === 0;
      return padded
        ? { tokens: [" ask", " not"], timestamps: [0.75, 1.5], durations: [0.4, 0.4] }
        : { tokens: [" not"], timestamps: [2.08], durations: [0.4] };
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

  it("re-decodes a window that skipped loud audio, with leading silence", async () => {
    const { code, stdout } = await runWorker(fakeRuntime(), "speech.wav");
    expect(code).toBe(0);
    const line = stdout.split("\n").find((l) => l.startsWith(SHERPA_RESULT_PREFIX))!;
    expect(JSON.parse(line.slice(SHERPA_RESULT_PREFIX.length))).toEqual([
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
