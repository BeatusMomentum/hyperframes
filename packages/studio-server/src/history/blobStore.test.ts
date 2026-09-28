// @vitest-environment node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NOT_A_REGULAR_FILE, openBlobStore } from "./blobStore";

const cleanup: string[] = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "hf-blob-store-"));
  cleanup.push(root);
  const blobs = join(root, "blobs");
  return { root, blobs, store: await openBlobStore(blobs) };
}

describe("blob store put", () => {
  it("copies a regular file and returns its sha256", async () => {
    const { root, store } = await setup();
    writeFileSync(join(root, "a.html"), "hello");
    const expected = createHash("sha256").update("hello").digest("hex");
    expect(await store.put(join(root, "a.html"))).toBe(expected);
    expect((await store.read(expected)).toString()).toBe("hello");
  });

  it.skipIf(process.platform === "win32")(
    "rejects a named pipe at once instead of waiting for a writer",
    async () => {
      const { root, blobs, store } = await setup();
      const pipe = join(root, "a.html");
      expect(spawnSync("mkfifo", [pipe]).status).toBe(0);
      await expect(store.put(pipe)).rejects.toMatchObject({ code: NOT_A_REGULAR_FILE });
      expect(readdirSync(blobs)).toEqual([]);
    },
    2_000,
  );

  it.skipIf(process.platform === "win32")("never follows a link", async () => {
    const { root, blobs, store } = await setup();
    writeFileSync(join(root, "outside.txt"), "secret");
    symlinkSync(join(root, "outside.txt"), join(root, "a.html"));
    await expect(store.put(join(root, "a.html"))).rejects.toMatchObject({ code: "ELOOP" });
    expect(readdirSync(blobs)).toEqual([]);
  });
});
