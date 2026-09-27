import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ensureWhisper = vi.fn(async (_options?: unknown) => {
  throw new Error("stop after the whisper step");
});
vi.mock("../whisper/manager.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../whisper/manager.js")>()),
  ensureWhisper: (options?: unknown) => ensureWhisper(options),
  findWhisper: () => undefined,
}));
vi.mock("@clack/prompts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@clack/prompts")>()),
  confirm: async () => true,
  spinner: () => ({ start() {}, stop() {}, message() {} }),
}));
vi.mock("./preview.js", async () => ({
  default: (await import("citty")).defineCommand({ run() {} }),
}));

import initCmd from "./init.js";

describe("init whisper install consent", () => {
  const realIsTTY = process.stdout.isTTY;
  let dir: string;
  let audio: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hf-init-whisper-"));
    audio = join(dir, "voice.wav");
    writeFileSync(audio, "not-real-audio");
    ensureWhisper.mockClear();
    vi.stubEnv("HYPERFRAMES_SKIP_SKILLS", "1");
    vi.stubEnv("HYPERFRAMES_NO_TELEMETRY", "1");
    vi.spyOn(console, "log").mockImplementation(() => {});
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  });
  afterEach(() => {
    Object.defineProperty(process.stdout, "isTTY", { value: realIsTTY, configurable: true });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("--non-interactive never installs whisper, even at a terminal", async () => {
    const name = join(dir, "proj");
    await initCmd.run!({ args: { name, "non-interactive": true, audio } } as never);

    expect(ensureWhisper).toHaveBeenCalledWith({ mayInstall: false });
  });

  it("interactive init installs whisper once the person says yes to captions", async () => {
    const name = join(dir, "proj");
    await initCmd.run!({ args: { name, audio } } as never);

    expect(ensureWhisper).toHaveBeenCalledWith(expect.objectContaining({ mayInstall: true }));
  });
});
