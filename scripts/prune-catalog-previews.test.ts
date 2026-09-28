import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  pruneItem,
  registryItems,
  withPreview,
  type Head,
  type Item,
} from "./prune-catalog-previews.ts";

const CDN = "https://static.heygen.ai/hyperframes-oss/docs/images/catalog";
const video = `${CDN}/blocks/demo-block.mp4`;
const poster = `${CDN}/blocks/demo-block.png`;
const olderPath =
  "https://static.heygen.ai/hyperframes-oss/registry/components/demo-comp/preview.mp4";

/** A CDN stub: URLs in `statuses` answer that status, "throw" rejects, anything else is 200. */
function cdn(statuses: Record<string, number | "throw">): Head {
  return async (target) => {
    const status = statuses[target] ?? 200;
    if (status === "throw") throw new Error("timeout");
    return status;
  };
}

function manifestText(name: string, preview?: unknown): string {
  const body = [
    `  "name": "${name}"`,
    `  "tags": ["a", "b"]`,
    `  "files": [{ "path": "${name}.html", "type": "hyperframes:composition" }]`,
  ];
  if (preview !== undefined)
    body.push(`  "preview": ${JSON.stringify(preview, null, 2).replaceAll("\n", "\n  ")}`);
  return `{\n${body.join(",\n")}\n}\n`;
}

function registry(t: TestContext, manifests: { kind: string; name: string; text: string }[]) {
  const root = mkdtempSync(join(tmpdir(), "prune-previews-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const { kind, name, text } of manifests) {
    mkdirSync(join(root, kind, name), { recursive: true });
    writeFileSync(join(root, kind, name, "registry-item.json"), text);
  }
  return {
    items: registryItems(root),
    read: (item: Item) => readFileSync(item.manifestPath, "utf8"),
  };
}

function one(t: TestContext, kind: string, name: string, text: string) {
  const { items, read } = registry(t, [{ kind, name, text }]);
  assert.equal(items.length, 1);
  const item = items[0]!;
  return { item, read: () => read(item) };
}

describe("prune-catalog-previews", () => {
  it("removes URLs answering 403 or 404 in blocks and components, leaving other fields as written", async (t) => {
    const { items, read } = registry(t, [
      { kind: "blocks", name: "demo-block", text: manifestText("demo-block", { video, poster }) },
      {
        kind: "components",
        name: "demo-comp",
        text: manifestText("demo-comp", { video: olderPath }),
      },
    ]);
    const head = cdn({ [video]: 404, [olderPath]: 403 });
    const [block, component] = items as [Item, Item];

    assert.deepEqual(await pruneItem(block, head), [video]);
    assert.deepEqual(await pruneItem(component, head), [olderPath]);
    assert.equal(read(block), manifestText("demo-block", { poster }));
    assert.equal(read(component), manifestText("demo-comp"));
  });

  it("keeps working links byte for byte, on any path", async (t) => {
    const text = manifestText("demo-comp", { video: olderPath, poster });
    const { item, read } = one(t, "components", "demo-comp", text);
    assert.deepEqual(await pruneItem(item, cdn({})), []);
    assert.equal(read(), text);
  });

  it("never removes a link on a transient answer", async (t) => {
    const text = manifestText("demo-block", { video, poster });
    const { item, read } = one(t, "blocks", "demo-block", text);
    assert.deepEqual(await pruneItem(item, cdn({ [video]: 503, [poster]: "throw" })), []);
    assert.equal(read(), text);
  });

  it("never adds a field or a sub-key", async (t) => {
    const bare = manifestText("demo-block");
    const posterOnly = manifestText("demo-comp", { poster });
    const { items, read } = registry(t, [
      { kind: "blocks", name: "demo-block", text: bare },
      { kind: "components", name: "demo-comp", text: posterOnly },
    ]);
    for (const item of items) assert.deepEqual(await pruneItem(item, cdn({})), []);
    const [block, component] = items as [Item, Item];
    assert.equal(read(block), bare);
    assert.equal(read(component), posterOnly);
  });

  it("removes a dead bare-string preview as one URL", async (t) => {
    const { item, read } = one(t, "blocks", "demo-block", manifestText("demo-block", olderPath));
    assert.deepEqual(await pruneItem(item, cdn({ [olderPath]: 403 })), [olderPath]);
    assert.equal(read(), manifestText("demo-block"));
  });
});

describe("prune-catalog-previews in-place rewrite", () => {
  const next = { poster };
  const shapes = {
    "nested object in preview": manifestText("demo-block", { poster: "old", meta: { w: 1 } }),
    "null preview": manifestText("demo-block", null),
    "4-space indent":
      JSON.stringify({ name: "demo-block", preview: { poster: "old" } }, null, 4) + "\n",
    "braces in a URL": manifestText("demo-block", { poster: "https://cdn.example/{old}.png" }),
    "preview as the first key": `{\n  "preview": { "poster": "old" },\n  "name": "demo-block"\n}\n`,
  };

  for (const [shape, text] of Object.entries(shapes)) {
    it(`rewrites or refuses, never leaving two preview keys: ${shape}`, () => {
      let out: string;
      try {
        out = withPreview(text, next);
      } catch (err) {
        assert.match(String(err), /Could not rewrite the preview entry in place/);
        return;
      }
      assert.equal(out.match(/"preview"\s*:/g)?.length, 1, out);
      assert.deepEqual(JSON.parse(out), { ...JSON.parse(text), preview: next });
    });
  }
});
