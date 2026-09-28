#!/usr/bin/env tsx
/**
 * Removes registry block and component `preview` links whose object is gone.
 *
 * For each item this HEADs every URL in its `preview` and drops the ones the CDN
 * answers with 403 or 404. It never adds or changes a link.
 *
 * Usage:
 *   npx tsx scripts/prune-catalog-previews.ts                   # every item
 *   npx tsx scripts/prune-catalog-previews.ts my-block my-comp  # named items
 *   npx tsx scripts/prune-catalog-previews.ts --dry-run         # report changes only
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { runAsCommand } from "./entrypoint.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const KINDS = ["blocks", "components"] as const;

export interface Item {
  kind: (typeof KINDS)[number];
  name: string;
  manifestPath: string;
}

/** Resolves to the HTTP status of a HEAD request; rejects when no response arrives. */
export type Head = (url: string) => Promise<number>;

const fetchHead: Head = async (url) =>
  (await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(10_000) })).status;

// S3 answers a missing key with 403, so 403 and 404 are the only answers that mean "absent".
const ABSENT = new Set([403, 404]);

async function statusOf(url: string, head: Head): Promise<number> {
  try {
    return await head(url);
  } catch {
    return 0;
  }
}

export function registryItems(registryDir: string, names: string[] = []): Item[] {
  return KINDS.flatMap((kind) => {
    const dir = join(registryDir, kind);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => names.length === 0 || names.includes(name))
      .map((name) => ({ kind, name, manifestPath: join(dir, name, "registry-item.json") }))
      .filter((item) => existsSync(item.manifestPath));
  });
}

/** The URLs a preview links: a bare string, or the string values of its object. */
function urls(preview: unknown): string[] {
  if (typeof preview === "string") return [preview];
  if (typeof preview !== "object" || preview === null) return [];
  return Object.values(preview).filter((url): url is string => typeof url === "string");
}

// A transient answer (5xx, timeout) never removes a link; only a definitive 403/404 does.
async function gone(url: unknown, head: Head): Promise<boolean> {
  return typeof url === "string" && ABSENT.has(await statusOf(url, head));
}

async function prunedObject(preview: object, head: Head): Promise<object | undefined> {
  const kept: [string, unknown][] = [];
  for (const entry of Object.entries(preview)) if (!(await gone(entry[1], head))) kept.push(entry);
  return kept.length > 0 ? Object.fromEntries(kept) : undefined;
}

/** The preview without its definitively missing URLs; undefined when nothing is left. */
export async function prunedPreview(preview: unknown, head: Head): Promise<unknown> {
  if (typeof preview === "object" && preview !== null) return prunedObject(preview, head);
  return (await gone(preview, head)) ? undefined : preview;
}

const PREVIEW_ENTRY = /,?\n {2}"preview": (?:\{[^{}]*\}|"[^"\n]*")/;

/** Rewrites only the top-level `preview` entry, so the rest of the file keeps its formatting. */
export function withPreview(text: string, preview: unknown): string {
  const entry =
    preview === undefined
      ? ""
      : `,\n  "preview": ${JSON.stringify(preview, null, 2).replaceAll("\n", "\n  ")}`;
  const next = PREVIEW_ENTRY.test(text)
    ? text.replace(PREVIEW_ENTRY, () => entry)
    : text.replace(/\n}\n?$/, () => `${entry}\n}\n`);
  assertOnlyPreviewChanged(text, next, preview);
  return next;
}

const previewKeys = (json: string) => json.match(/"preview"\s*:/g)?.length ?? 0;

function parsed(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

function assertOnlyPreviewChanged(text: string, next: string, preview: unknown) {
  const expected = JSON.parse(text);
  const keys = previewKeys(text) - Number("preview" in expected) + Number(preview !== undefined);
  delete expected.preview;
  if (preview !== undefined) expected.preview = preview;
  // JSON.parse keeps the last of two equal keys, so only the key count sees an entry left behind.
  if (previewKeys(next) !== keys || !isDeepStrictEqual(parsed(next), expected))
    throw new Error("Could not rewrite the preview entry in place");
}

/** Prunes one manifest; returns the URLs it removed (empty when unchanged). */
export async function pruneItem(item: Item, head: Head, write = true): Promise<string[]> {
  const text = readFileSync(item.manifestPath, "utf8");
  const current = JSON.parse(text).preview;
  const next = await prunedPreview(current, head);
  if (isDeepStrictEqual(current, next)) return [];
  if (write) writeFileSync(item.manifestPath, withPreview(text, next));
  const kept = urls(next);
  return urls(current).filter((url) => !kept.includes(url));
}

async function prune(names: string[], write: boolean, head: Head): Promise<void> {
  let items = 0;
  let removed = 0;
  for (const item of registryItems(join(repoRoot, "registry"), names)) {
    const gone = await pruneItem(item, head, write);
    gone.forEach((url) => console.log(`- ${item.kind}/${item.name} ${url}`));
    removed += gone.length;
    if (gone.length > 0) items++;
  }
  const verb = write ? "pruned" : "would prune";
  console.log(`\n${verb} ${removed} URL(s) on ${items} item(s)`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const names = args.filter((arg) => !arg.startsWith("--"));
  return prune(names, !args.includes("--dry-run"), fetchHead);
}

runAsCommand(import.meta.url, main);
