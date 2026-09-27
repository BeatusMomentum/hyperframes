import { loadInstalled } from "../utils/optionalPackages.js";
import {
  silenceCuts,
  SHERPA_ERROR_PREFIX,
  SHERPA_RESULT_PREFIX,
  type SherpaWindow,
} from "./parakeet.js";

interface Wave {
  samples: Float32Array;
  sampleRate: number;
}

interface SherpaOnnx {
  readWave(path: string): Wave;
  OfflineRecognizer: new (config: object) => {
    createStream(): { acceptWaveform(wave: Wave): void };
    decode(stream: unknown): void;
    getResult(stream: unknown): Omit<SherpaWindow, "offset">;
  };
}

const { wavPath, runtimeDir, config } = JSON.parse(process.env.HYPERFRAMES_PARAKEET_INPUT ?? "{}");

try {
  const sherpa = loadInstalled(runtimeDir, "sherpa-onnx-node") as SherpaOnnx | null;
  if (!sherpa) throw new Error(`sherpa-onnx-node is not installed in ${runtimeDir}`);
  const recognizer = new sherpa.OfflineRecognizer(config);
  const wave = sherpa.readWave(wavPath);
  const cuts = silenceCuts(wave.samples, wave.sampleRate);
  const windows: SherpaWindow[] = [];
  for (let k = 0; k + 1 < cuts.length; k++) {
    const stream = recognizer.createStream();
    const samples = wave.samples.subarray(cuts[k], cuts[k + 1]);
    stream.acceptWaveform({ sampleRate: wave.sampleRate, samples });
    recognizer.decode(stream);
    const { tokens, timestamps, durations } = recognizer.getResult(stream);
    windows.push({ offset: cuts[k]! / wave.sampleRate, tokens, timestamps, durations });
  }
  process.stdout.write(`${SHERPA_RESULT_PREFIX}${JSON.stringify(windows)}\n`);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  // Rethrow after the flush: a pipe write is asynchronous on macOS and a crash would drop it.
  process.stderr.write(`${SHERPA_ERROR_PREFIX}${message}\n`, () => {
    throw err;
  });
}
