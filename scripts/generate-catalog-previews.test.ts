import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateAll } from "./generate-catalog-previews.ts";

const repoRoot = resolve(import.meta.dirname, "..");
const previewPath = resolve(repoRoot, "docs/images/catalog/blocks/thread-message-stack.png");

after(() => rmSync(previewPath, { force: true }));

describe("catalog preview raw block boundary", () => {
  it("renders thread-message-stack through the exact Catalog Previews command", () => {
    rmSync(previewPath, { force: true });
    const result = spawnSync(
      "bunx",
      [
        "tsx",
        "scripts/generate-catalog-previews.ts",
        "--only",
        "thread-message-stack",
        "--skip-video",
      ],
      { cwd: repoRoot, encoding: "utf8", timeout: 120_000 },
    );
    const output = `${result.stdout}${result.stderr}`;

    assert.equal(result.status, 0, output);
    assert.ok(!output.includes("✗ thread-message-stack"), output);
    assert.ok(!output.includes("[Browser:ERROR]"), output);
    assert.ok(!output.includes("timelines not registered"), output);
    assert.ok(!output.includes("sub_timeline_readiness_timeout"), output);
    assert.ok(output.includes("✓ thread-message-stack.png"), output);
    assert.ok(existsSync(previewPath), previewPath);
  });
});

describe("catalog preview failures", () => {
  const items = ["first", "broken", "last"].map((name) => ({
    name,
    kind: "block" as const,
    sourceDir: "",
    entryFile: "",
  }));

  it("renders every item, then fails naming the ones that failed", async () => {
    const rendered: string[] = [];
    const run = generateAll(items, true, async (item) => {
      rendered.push(item.name);
      if (item.name === "broken") throw new Error("render timed out");
    });
    await assert.rejects(run, /1 item\(s\) failed to render: broken/);
    assert.deepEqual(rendered, ["first", "broken", "last"]);
  });

  it("does not fail an item for a runner without a WebGPU adapter", async () => {
    await generateAll(items, true, async () => {
      throw new Error("no WebGPU adapter");
    });
  });
});
