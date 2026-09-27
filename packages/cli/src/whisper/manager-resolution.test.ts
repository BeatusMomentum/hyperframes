import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// brew, git and cmake are on PATH; any command but a which/where lookup counts as an install.
const state = vi.hoisted(() => ({
  attended: false,
  installs: [] as string[],
  parakeetBlocked: null as string | null,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: vi.fn((command: string, args: string[]) => {
      if (command === "which" || command === "where") {
        if (args[0] === "whisper") return "/fake/python-whisper\n";
        if (["brew", "git", "cmake"].includes(args[0] ?? "")) return `/fake/${args[0]}\n`;
        throw new Error(`${args[0]} not found`);
      }
      state.installs.push(`${command} ${args.join(" ")}`);
      throw new Error(`${command} failed`);
    }),
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: vi.fn(() => false), mkdirSync: vi.fn(), rmSync: vi.fn() };
});

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  platform: () => "darwin",
}));

vi.mock("../utils/attendedTerminal.js", () => ({ isAttendedTerminal: () => state.attended }));
vi.mock("./sherpaSupport.js", () => ({ sherpaUnsupportedReason: () => state.parakeetBlocked }));

describe("findWhisper", () => {
  it("does not treat the OpenAI Python whisper command as whisper.cpp", async () => {
    const { findWhisper } = await import("./manager.js");

    expect(findWhisper()).toBeUndefined();
  });
});

// Lookups run `where` when process.platform is win32, so cover both hosts on every CI lane.
describe.each(["linux", "win32"])("ensureWhisper on a %s host", (hostPlatform) => {
  const realPlatform = process.platform;
  const unattendedError = {
    code: "WHISPER_UNAVAILABLE",
    message: expect.stringMatching(/hyperframes models install parakeet.*brew install whisper-cpp/),
  };

  beforeEach(() => {
    state.installs.length = 0;
    state.parakeetBlocked = null;
    Object.defineProperty(process, "platform", { value: hostPlatform });
  });

  afterAll(() => {
    Object.defineProperty(process, "platform", { value: realPlatform });
  });

  it("an unattended run only probes: no brew, no source build", async () => {
    state.attended = false;
    const { ensureWhisper } = await import("./manager.js");

    await expect(ensureWhisper()).rejects.toMatchObject(unattendedError);
    expect(state.installs).toEqual([]);
  });

  it("an unattended run where Parakeet cannot run gives only the whisper-cpp instruction", async () => {
    state.attended = false;
    state.parakeetBlocked = "Parakeet needs glibc 2.32 or newer; this system has glibc 2.31.";
    const { ensureWhisper } = await import("./manager.js");

    const err = await ensureWhisper().catch((e: Error) => e);
    expect(err).toMatchObject({ code: "WHISPER_UNAVAILABLE" });
    expect(err.message).toMatch(/Install whisper-cpp: brew install whisper-cpp$/);
    expect(err.message).not.toContain("parakeet");
    expect(state.installs).toEqual([]);
  });

  it("mayInstall: false only probes, even at a terminal", async () => {
    state.attended = true;
    const { ensureWhisper } = await import("./manager.js");

    await expect(ensureWhisper({ mayInstall: false })).rejects.toMatchObject(unattendedError);
    expect(state.installs).toEqual([]);
  });

  it("an attended run still tries brew, then a source build", async () => {
    state.attended = true;
    const { ensureWhisper } = await import("./manager.js");

    await expect(ensureWhisper()).rejects.toMatchObject({ code: "WHISPER_UNAVAILABLE" });
    expect(state.installs).toEqual([
      "brew install whisper-cpp",
      expect.stringMatching(/^git clone /),
    ]);
  });
});
