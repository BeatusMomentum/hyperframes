import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DownloadOptions } from "../cloud/download.js";
import {
  ensureParakeetModel,
  installSherpaRuntime,
  sherpaPlatformPackage,
  sherpaUnsupportedReason,
  type ModelFile,
} from "./sherpa.js";

const file = (name: string, content: string): ModelFile => ({
  name,
  bytes: Buffer.byteLength(content),
  sha256: createHash("sha256").update(content).digest("hex"),
});

/** A downloader that serves `served[name]` for any URL ending in that name. */
function fakeDownload(served: Record<string, string>) {
  return vi.fn(async (url: string, dest: string, opts?: DownloadOptions) => {
    const content = served[url.split("/").at(-1)!]!;
    writeFileSync(dest, content);
    opts?.onProgress?.(Buffer.byteLength(content), undefined);
    return { path: dest, bytes: Buffer.byteLength(content) };
  });
}

describe("installSherpaRuntime", () => {
  it.each([
    ["darwin", "arm64", "sherpa-onnx-darwin-arm64@1.13.8"],
    ["linux", "x64", "sherpa-onnx-linux-x64@1.13.8"],
    ["win32", "ia32", "sherpa-onnx-win-ia32@1.13.8"],
  ])("pins the %s-%s native package", (platform, arch, spec) => {
    expect(sherpaPlatformPackage(platform as NodeJS.Platform, arch)).toBe(spec);
  });

  it("asks npm for the runtime and its native package at the same exact version", async () => {
    const run = vi.fn(async () => {
      throw new Error("stop before touching the cache");
    });
    await installSherpaRuntime(run).catch(() => undefined);
    const args = run.mock.calls[0]?.[0] as string[] | undefined;
    expect(args).toContain("sherpa-onnx-node@1.13.8");
    expect(args).toContain(sherpaPlatformPackage());
  });
});

describe("ensureParakeetModel", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const tempDir = () => (dir = mkdtempSync(join(tmpdir(), "hf-parakeet-model-")));

  it("refuses a file whose sha256 does not match and leaves nothing under its name", async () => {
    tempDir();
    const files = [file("encoder.onnx", "abc")];
    const download = fakeDownload({ "encoder.onnx": "abd" });

    await expect(ensureParakeetModel({ dir, files, download })).rejects.toThrow(/sha256/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("fetches only what is missing or corrupt, then is a no-op", async () => {
    tempDir();
    mkdirSync(dir, { recursive: true });
    const files = [
      file("encoder.onnx", "enc"),
      file("tokens.txt", "tok"),
      file("joiner.onnx", "j"),
    ];
    writeFileSync(join(dir, "encoder.onnx"), "enc");
    writeFileSync(join(dir, "tokens.txt"), "xxx");
    const download = fakeDownload({ "tokens.txt": "tok", "joiner.onnx": "j" });
    const onBytes = vi.fn();

    expect(await ensureParakeetModel({ dir, files, download, onBytes })).toBe(true);
    expect(download.mock.calls.map(([url]) => url.split("/").at(-1))).toEqual([
      "tokens.txt",
      "joiner.onnx",
    ]);
    expect(readdirSync(dir).sort()).toEqual(["encoder.onnx", "joiner.onnx", "tokens.txt"]);
    expect(onBytes.mock.calls.at(-1)).toEqual([4, 4]);

    download.mockClear();
    expect(await ensureParakeetModel({ dir, files, download })).toBe(false);
    expect(download).not.toHaveBeenCalled();
    expect(existsSync(join(dir, "tokens.txt"))).toBe(true);
  });
});

describe("sherpaUnsupportedReason", () => {
  it("refuses glibc older than 2.32 and accepts newer or non-glibc systems", () => {
    const glibc = (version?: string) => ({ header: { glibcVersionRuntime: version } });
    expect(sherpaUnsupportedReason(glibc("2.31"))).toMatch(/glibc 2\.32/);
    expect(sherpaUnsupportedReason(glibc("2.32"))).toBeNull();
    expect(sherpaUnsupportedReason(glibc("2.36"))).toBeNull();
    expect(sherpaUnsupportedReason(glibc())).toBeNull();
  });
});
