import { execFile, type ExecFileException } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { downloadToFile } from "../cloud/download.js";
import { CACHE_DIR, install, isInstalled } from "../utils/optionalPackages.js";
import {
  mergeWindowsToWords,
  SHERPA_ERROR_PREFIX,
  SHERPA_RESULT_PREFIX,
  writeParakeetTranscript,
  type SherpaWindow,
} from "./parakeet.js";
import { prepareWav, type TranscribeResult } from "./transcribe.js";

const RUNTIME = "sherpa-onnx-node";
const RUNTIME_VERSION = "1.13.8";
export const SHERPA_RUNTIME_DIR = join(CACHE_DIR, `${RUNTIME}@${RUNTIME_VERSION}`);

const MODEL_REPO = "csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8";
const MODEL_REVISION = "2bda32ec70b097a55adaa07d9a7173915b43cc78";
export const PARAKEET_MODEL_DIR = join(
  homedir(),
  ".cache",
  "hyperframes",
  "parakeet",
  "parakeet-tdt-0.6b-v3-int8",
);

export interface ModelFile {
  name: string;
  bytes: number;
  sha256: string;
}

/** Order matters: encoder, decoder, joiner, tokens (see recognizerConfig). */
const PARAKEET_MODEL_FILES: readonly ModelFile[] = [
  {
    name: "encoder.int8.onnx",
    bytes: 652_184_281,
    sha256: "acfc2b4456377e15d04f0243af540b7fe7c992f8d898d751cf134c3a55fd2247",
  },
  {
    name: "decoder.int8.onnx",
    bytes: 11_845_275,
    sha256: "179e50c43d1a9de79c8a24149a2f9bac6eb5981823f2a2ed88d655b24248db4e",
  },
  {
    name: "joiner.int8.onnx",
    bytes: 6_355_277,
    sha256: "3164c13fc2821009440d20fcb5fdc78bff28b4db2f8d0f0b329101719c0948b3",
  },
  {
    name: "tokens.txt",
    bytes: 93_939,
    sha256: "d58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d",
  },
];

const DECODE_TIMEOUT_MS = 1_800_000;

type ProcessReport = { header?: { glibcVersionRuntime?: string } };

/** Why sherpa-onnx cannot run here, or null. Its Linux prebuilt needs glibc 2.32. */
export function sherpaUnsupportedReason(
  report = process.report.getReport() as ProcessReport,
): string | null {
  const glibc = report.header?.glibcVersionRuntime;
  if (!glibc) return null;
  const [major = 0, minor = 0] = glibc.split(".").map(Number);
  if (major > 2 || (major === 2 && minor >= 32)) return null;
  return `Parakeet needs glibc 2.32 or newer; this system has glibc ${glibc}.`;
}

export function sherpaRuntimeInstalled(): boolean {
  return isInstalled(SHERPA_RUNTIME_DIR, RUNTIME);
}

export function installSherpaRuntime(): Promise<void> {
  return install(SHERPA_RUNTIME_DIR, RUNTIME, RUNTIME_VERSION);
}

/** Sizes only: hashing 650 MB on every transcribe is too slow, and install already verified them. */
export function sherpaParakeetInstalled(): boolean {
  return (
    sherpaRuntimeInstalled() &&
    PARAKEET_MODEL_FILES.every(
      (f) =>
        statSync(join(PARAKEET_MODEL_DIR, f.name), { throwIfNoEntry: false })?.size === f.bytes,
    )
  );
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function verifies(path: string, file: ModelFile): Promise<boolean> {
  if (statSync(path, { throwIfNoEntry: false })?.size !== file.bytes) return false;
  return (await sha256File(path)) === file.sha256;
}

interface EnsureModelOptions {
  dir?: string;
  files?: readonly ModelFile[];
  download?: typeof downloadToFile;
  onBytes?: (done: number, total: number) => void;
}

/**
 * Fetches every file that does not verify under a temp name, checks size and sha256, then renames
 * it into place, so a file under its real name is always complete. False when all already verified.
 */
export async function ensureParakeetModel({
  dir = PARAKEET_MODEL_DIR,
  files = PARAKEET_MODEL_FILES,
  download = downloadToFile,
  onBytes,
}: EnsureModelOptions = {}): Promise<boolean> {
  const missing: ModelFile[] = [];
  for (const file of files) if (!(await verifies(join(dir, file.name), file))) missing.push(file);
  const total = missing.reduce((sum, f) => sum + f.bytes, 0);
  let done = 0;
  for (const file of missing) {
    const dest = join(dir, file.name);
    const temp = `${dest}.${process.pid}.download`;
    rmSync(dest, { force: true });
    try {
      const url = `https://huggingface.co/${MODEL_REPO}/resolve/${MODEL_REVISION}/${file.name}`;
      await download(url, temp, { onProgress: (bytes) => onBytes?.(done + bytes, total) });
      if (!(await verifies(temp, file))) {
        throw new Error(
          `${file.name} did not match its pinned size and sha256, so it was discarded. Re-run to retry.`,
        );
      }
      renameSync(temp, dest);
    } finally {
      rmSync(temp, { force: true });
    }
    done += file.bytes;
  }
  return missing.length > 0;
}

function recognizerConfig(): object {
  const [encoder, decoder, joiner, tokens] = PARAKEET_MODEL_FILES.map((f) =>
    join(PARAKEET_MODEL_DIR, f.name),
  );
  return {
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: { encoder, decoder, joiner },
      tokens,
      numThreads: 4,
      provider: "cpu",
      debug: 0,
      modelType: "nemo_transducer",
    },
    decodingMethod: "greedy_search",
  };
}

function failureReason(err: ExecFileException | null, stderr: string): string {
  const how = !err
    ? "exited without a result"
    : err.killed
      ? "timed out"
      : err.signal
        ? `crashed (${err.signal})`
        : `exited with code ${err.code}`;
  const lines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const why =
    lines.find((line) => line.startsWith(SHERPA_ERROR_PREFIX))?.slice(SHERPA_ERROR_PREFIX.length) ??
    lines.at(-1);
  return why ? `${how}: ${why}` : how;
}

/** Decodes in a child process: onnxruntime aborts the whole process on some inputs, uncatchably. */
function decode(wavPath: string): Promise<SherpaWindow[]> {
  const sourceMode = import.meta.url.endsWith(".ts");
  const worker = new URL(sourceMode ? "./sherpaWorker.ts" : "./sherpaWorker.js", import.meta.url);
  const args = [...(sourceMode ? ["--import", "tsx"] : []), fileURLToPath(worker)];
  const input = { wavPath, runtimeDir: SHERPA_RUNTIME_DIR, config: recognizerConfig() };
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      args,
      {
        env: { ...process.env, HYPERFRAMES_PARAKEET_INPUT: JSON.stringify(input) },
        maxBuffer: 256 * 1024 * 1024,
        timeout: DECODE_TIMEOUT_MS,
      },
      (err, stdout, stderr) => {
        const line = stdout.split("\n").find((l) => l.startsWith(SHERPA_RESULT_PREFIX));
        if (!err && line) resolve(JSON.parse(line.slice(SHERPA_RESULT_PREFIX.length)));
        else reject(new Error(`Parakeet decoder ${failureReason(err, stderr)}`));
      },
    );
  });
}

export async function transcribeWithSherpa(
  inputPath: string,
  dir: string,
  options?: { onProgress?: (message: string) => void },
): Promise<TranscribeResult> {
  const unsupported = sherpaUnsupportedReason();
  if (unsupported) throw new Error(unsupported);
  const wavPath = prepareWav(inputPath, options?.onProgress);
  try {
    options?.onProgress?.("Transcribing with Parakeet...");
    return writeParakeetTranscript(dir, mergeWindowsToWords(await decode(wavPath)));
  } finally {
    if (wavPath !== inputPath) rmSync(wavPath, { force: true });
  }
}
