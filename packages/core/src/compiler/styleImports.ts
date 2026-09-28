import { SCENE_PART_ATTR } from "../sceneParts";
import { cssStyleMergeKey } from "./scriptRuns";

export const CSS_IMPORT_RE =
  /@import\s+(?:url\(\s*(["']?)([^)"']+)\1\s*\)|(["'])([^"']+)\3)\s*([^;]*);\s*/g;

// css-cascade-5 §2: `layer` and `supports()` sit before an @import's media list.
const IMPORT_LAYER_SUPPORTS_RE =
  /^(?:layer(?:\([^)]*\))?\s*)?(?:supports\((?:[^()]|\([^()]*\))*\)\s*)?/i;
const TYPED_QUERY_RE = /^(?:only\s+)?([a-z-]+)(?:\s+and\s+([\s\S]+))?$/i;

/** The media a style applies under: "" for always, undefined when the browser does not read it as CSS. */
function styleMedia(el: Element): string | undefined {
  const key = cssStyleMergeKey(el);
  return key === undefined ? undefined : (JSON.parse(key) as [string, string])[0];
}

function mediaQueries(list: string): string[] {
  return list.split(/,(?![^(]*\))/).map((query) => query.trim());
}

/** `[type, condition]`, or null for a `not <type>` query, whose negation covers its type too. */
function splitQuery(query: string): [string, string | undefined] | null {
  if (/^(?:not\s*)?\(/i.test(query)) return ["all", query];
  const match = TYPED_QUERY_RE.exec(query);
  if (!match || match[1]!.toLowerCase() === "not") return null;
  return [match[1]!.toLowerCase(), match[2]];
}

const group = (condition: string) =>
  /^\([^()]*\)$/.test(condition) ? condition : `(${condition})`;

// A `not <type>` query ANDed with another has no CSS spelling (MQ4 §3), so it becomes `not all`.
function bothQueries(a: string, b: string): string {
  const [left, right] = [splitQuery(a), splitQuery(b)];
  const type = left && right ? sharedType(left[0], right[0]) : null;
  if (type === null) return "not all";
  const conditions = [left![1], right![1]].filter((c): c is string => Boolean(c));
  if (conditions.length === 0) return type;
  if (type === "all" && conditions.length === 1) return conditions[0]!;
  const condition = conditions.map(group).join(" and ");
  return type === "all" ? condition : `${type} and ${condition}`;
}

function sharedType(left: string, right: string): string | null {
  if (left === "all" || left === right) return right;
  return right === "all" ? left : null;
}

/** Media Queries 4 §2.1: a list matches when any query does, so two lists intersect pairwise. */
function intersectMedia(outer: string, inner: string): string {
  if (!outer || !inner) return outer || inner;
  const queries = mediaQueries(outer).flatMap((a) =>
    mediaQueries(inner).map((b) => bothQueries(a, b)),
  );
  const matching = [...new Set(queries.filter((query) => query !== "not all"))];
  return matching.length > 0 ? matching.join(", ") : "not all";
}

export interface StyleImport {
  /** The `url(...)` target; undefined for the string form. */
  url?: string;
  layerSupports: string;
  media: string;
}

/** Removes each `@import` of a CSS style that `take` accepts, returning it under the media it applied under. */
export function takeStyleImports(
  el: Element,
  take: (found: StyleImport) => boolean = () => true,
): StyleImport[] {
  const styleApplies = styleMedia(el);
  if (styleApplies === undefined) return [];
  const taken: StyleImport[] = [];
  const rest = (el.textContent || "").replace(
    CSS_IMPORT_RE,
    (match, _q1, url, _q2, _path, conditions: string) => {
      const layerSupports = IMPORT_LAYER_SUPPORTS_RE.exec(conditions)![0];
      const media = intersectMedia(styleApplies, conditions.slice(layerSupports.length).trim());
      const found = { url, layerSupports, media };
      if (!take(found)) return match;
      taken.push(found);
      return "";
    },
  );
  if (taken.length > 0) el.textContent = rest;
  return taken;
}

function withoutImports(css: string, imports: Set<string>): string {
  return css.replace(CSS_IMPORT_RE, (match) => (imports.add(match.trim()), "")).trim();
}

/** Joins same-condition sheets into one, each distinct `@import` moved to the front, where CSS allows it. */
export function joinCssHoistingImports(sheets: string[]): string {
  const imports = new Set<string>();
  const rest = sheets.map((sheet) => withoutImports(sheet, imports)).filter(Boolean);
  return [...imports, ...rest].join("\n\n").trim();
}

/** Moves each distinct `@import` of a same-condition run to the front of its first style, or of a
 * holder with the run's media and title before it when that first style is a swappable scene part. */
export function hoistStyleImports(run: Element[]): void {
  const imports = new Set<string>();
  for (const el of run) el.textContent = withoutImports(el.textContent || "", imports);
  if (imports.size === 0) return;
  const hoisted = [...imports].join("\n\n");
  const first = run[0]!;
  if (!first.hasAttribute(SCENE_PART_ATTR)) {
    first.textContent = [hoisted, first.textContent].filter(Boolean).join("\n\n");
    return;
  }
  const holder = first.ownerDocument.createElement("style");
  for (const name of ["media", "title"]) {
    const value = first.getAttribute(name);
    if (value !== null) holder.setAttribute(name, value);
  }
  holder.textContent = hoisted;
  first.before(holder);
}
