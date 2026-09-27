import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DownloadOptions } from "../cloud/download.js";
import {
  ensureParakeetModel,
  installSherpaRuntime,
  SHERPA_RUNTIME_DIR,
  sherpaPlatformPackage,
  sherpaRuntimeInstalled,
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
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content);
    opts?.signal?.throwIfAborted();
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
    expect(sherpaPlatformPackage(platform as NodeJS.Platform, arch as NodeJS.Architecture)).toBe(
      spec,
    );
  });

  it("asks npm for the runtime and its native package at the same exact version", async () => {
    const run = vi.fn(async (_args: string[]) => {
      throw new Error("stop before touching the cache");
    });
    const cancel = new AbortController();
    await installSherpaRuntime({ run, signal: cancel.signal }).catch(() => undefined);
    expect((run.mock.calls[0] as unknown[] | undefined)?.[1]).toBe(cancel.signal);
    const args = run.mock.calls[0]?.[0] as string[] | undefined;
    expect(args).toContain("sherpa-onnx-node@1.13.8");
    expect(args).toContain(sherpaPlatformPackage());
  });

  it("repairs a runtime whose native binary is missing instead of calling it installed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hf-sherpa-runtime-"));
    const native = sherpaPlatformPackage().replace(/@[^@]+$/, "");
    const manifest = (root: string, name: string) => {
      mkdirSync(join(root, "node_modules", name), { recursive: true });
      writeFileSync(join(root, "node_modules", name, "package.json"), `{"name":"${name}"}`);
    };
    try {
      manifest(dir, "sherpa-onnx-node");
      manifest(dir, native);
      expect(sherpaRuntimeInstalled(dir)).toBe(false);
      const run = vi.fn(async (args: string[]) => {
        const staging = args[args.indexOf("--prefix") + 1]!;
        manifest(staging, "sherpa-onnx-node");
        manifest(staging, native);
        writeFileSync(join(staging, "node_modules", native, "sherpa-onnx.node"), "binary");
      });

      await installSherpaRuntime({ run, dir });
      expect(run).toHaveBeenCalledTimes(1);
      expect(existsSync(join(dir, "node_modules", native, "sherpa-onnx.node"))).toBe(true);
      expect(sherpaRuntimeInstalled(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps each platform and arch in its own runtime dir", () => {
    expect(SHERPA_RUNTIME_DIR).toMatch(
      new RegExp(`sherpa-onnx-node@1\\.13\\.8-${process.platform}-${process.arch}$`),
    );
  });
});

describe("ensureParakeetModel", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const tempDir = () => (dir = mkdtempSync(join(tmpdir(), "hf-parakeet-model-")));
  const stagingLeft = () =>
    readdirSync(dirname(dir)).filter((name) => name.startsWith(`${basename(dir)}.tmp-`));

  it("refuses a file whose sha256 does not match and leaves nothing under its name", async () => {
    tempDir();
    const files = [file("encoder.onnx", "abc")];
    const download = fakeDownload({ "encoder.onnx": "abd" });

    await expect(ensureParakeetModel({ dir, files, download })).rejects.toThrow(/sha256/);
    expect(readdirSync(dir)).toEqual([]);
    expect(stagingLeft()).toEqual([]);
  });

  it("names the file, the host and a retry when a download fails", async () => {
    tempDir();
    const download = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(
      ensureParakeetModel({ dir, files: [file("encoder.onnx", "enc")], download }),
    ).rejects.toThrow(
      "Could not download encoder.onnx from huggingface.co (fetch failed). Check your network and re-run.",
    );
    expect(stagingLeft()).toEqual([]);
  });

  it("stops at the next file on cancel, keeping only files that verified", async () => {
    tempDir();
    const files = [file("encoder.onnx", "enc"), file("tokens.txt", "tok")];
    const cancel = new AbortController();
    const download = fakeDownload({ "encoder.onnx": "enc", "tokens.txt": "tok" });
    download.mockImplementationOnce(async (_url, dest) => {
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, "enc");
      cancel.abort();
      return { path: dest, bytes: 3 };
    });

    await expect(
      ensureParakeetModel({ dir, files, download, signal: cancel.signal }),
    ).rejects.toThrow(/abort/i);
    expect(download).toHaveBeenCalledTimes(1);
    expect(download.mock.calls[0]?.[2]?.signal).toBe(cancel.signal);
    expect(readdirSync(dir)).toEqual(["encoder.onnx"]);
    expect(stagingLeft()).toEqual([]);
  });

  it("sweeps the staging dir a killed install left behind", async () => {
    tempDir();
    const stale = `${dir}.tmp-999999999-dead`;
    mkdirSync(stale);
    writeFileSync(join(stale, "encoder.onnx"), "half");
    const files = [file("tokens.txt", "tok")];

    await ensureParakeetModel({ dir, files, download: fakeDownload({ "tokens.txt": "tok" }) });
    expect(existsSync(stale)).toBe(false);
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
  const linux = (glibc?: string) => ({ platform: "linux", arch: "x64", glibc });

  it("refuses Linux without glibc 2.32 and accepts newer glibc", () => {
    expect(sherpaUnsupportedReason(linux("2.31"))).toMatch(/glibc 2\.32.*2\.31/);
    expect(sherpaUnsupportedReason(linux())).toMatch(/musl/);
    expect(sherpaUnsupportedReason(linux("2.32"))).toBeNull();
    expect(sherpaUnsupportedReason(linux("2.36"))).toBeNull();
  });

  it("refuses targets with no native package, naming the ones that have one", () => {
    expect(sherpaUnsupportedReason({ platform: "darwin", arch: "arm64" })).toBeNull();
    expect(sherpaUnsupportedReason({ platform: "win32", arch: "x64" })).toBeNull();
    expect(sherpaUnsupportedReason({ platform: "win32", arch: "arm64" })).toMatch(
      /darwin-arm64.*win32-ia32; this system is win32-arm64/,
    );
    expect(sherpaUnsupportedReason({ platform: "linux", arch: "arm", glibc: "2.36" })).toMatch(
      /this system is linux-arm/,
    );
  });
});
