import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The real whisper manager runs: brew, git and cmake are on PATH, and any call to them counts as an install.
const state = vi.hoisted(() => ({ home: "", installs: [] as string[] }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const tools = ["brew", "git", "cmake"];
  return {
    ...actual,
    execFileSync: vi.fn((command: string, args: string[], options?: unknown) => {
      if (command === "which" || command === "where") {
        if (tools.includes(args[0] ?? "")) return `/fake/${args[0]}\n`;
        throw new Error(`${args[0]} not found`);
      }
      if (!tools.includes(command)) return actual.execFileSync(command, args, options as never);
      state.installs.push(`${command} ${args.join(" ")}`);
      throw new Error(`${command} failed`);
    }),
  };
});
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => state.home,
  platform: () => "linux",
}));
const confirm = vi.fn(async () => true);
vi.mock("@clack/prompts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@clack/prompts")>()),
  confirm: () => confirm(),
  spinner: () => ({ start() {}, stop() {}, message() {} }),
}));
vi.mock("./preview.js", async () => ({
  default: (await import("citty")).defineCommand({ run() {} }),
}));

state.home = mkdtempSync(join(tmpdir(), "hf-init-whisper-home-"));
const { default: initCmd } = await import("./init.js");
afterAll(() => rmSync(state.home, { recursive: true, force: true }));

describe("init whisper install consent", () => {
  const realStdin = process.stdin.isTTY;
  const realStdout = process.stdout.isTTY;
  let dir: string;
  let audio: string;
  let log: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hf-init-whisper-"));
    audio = join(dir, "voice.wav");
    writeFileSync(audio, "not-real-audio");
    state.installs.length = 0;
    confirm.mockClear();
    vi.stubEnv("HYPERFRAMES_SKIP_SKILLS", "1");
    vi.stubEnv("HYPERFRAMES_NO_TELEMETRY", "1");
    vi.stubEnv("HYPERFRAMES_WHISPER_PATH", "");
    vi.stubEnv("CI", "");
    log = vi.spyOn(console, "log").mockImplementation(() => {});
    for (const stream of [process.stdin, process.stdout]) {
      Object.defineProperty(stream, "isTTY", { value: true, configurable: true });
    }
  });
  afterEach(() => {
    Object.defineProperty(process.stdin, "isTTY", { value: realStdin, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: realStdout, configurable: true });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  const printed = () => log.mock.calls.flat().join("\n");

  it("--non-interactive never installs whisper, even at a terminal", async () => {
    await initCmd.run!({
      args: { name: join(dir, "proj"), "non-interactive": true, audio },
    } as never);

    expect(state.installs).toEqual([]);
    expect(printed()).toContain("hyperframes models install parakeet");
  });

  it("CI with both streams on a terminal offers no install prompt and installs nothing", async () => {
    vi.stubEnv("CI", "1");
    await initCmd.run!({ args: { name: join(dir, "proj"), audio, example: "blank" } } as never);

    expect(confirm).not.toHaveBeenCalled();
    expect(state.installs).toEqual([]);
    expect(printed()).toContain("hyperframes models install parakeet");
  });

  it("an attended yes to captions still installs whisper", async () => {
    await initCmd.run!({ args: { name: join(dir, "proj"), audio, example: "blank" } } as never);

    expect(confirm).toHaveBeenCalled();
    expect(state.installs[0]).toMatch(/^git clone .*whisper\.cpp/);
  });
});
