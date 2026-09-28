export interface InlineScriptRun {
  members: Element[];
  /** First later script that executes on its own; the merged run must stay before it. Null: end of body. */
  anchor: Element | null;
}

function isClassicInline(el: Element): boolean {
  const type = (el.getAttribute("type") || "").trim().toLowerCase();
  return !type || type === "text/javascript" || type === "application/javascript";
}

function isSeparateExecution(el: Element, isPinned: (el: Element) => boolean): boolean {
  return (
    el.hasAttribute("src") ||
    isPinned(el) ||
    (el.getAttribute("type") || "").trim().toLowerCase() === "module"
  );
}

/** Groups body scripts into runs of classic inline scripts split by any script that executes
 * separately (src, module, or one the caller pins in place), so merging a run never reorders it past one. */
export function inlineScriptRuns(
  scripts: readonly Element[],
  isPinned: (el: Element) => boolean = () => false,
): InlineScriptRun[] {
  const runs: InlineScriptRun[] = [];
  let members: Element[] = [];
  for (const el of scripts) {
    if (isSeparateExecution(el, isPinned)) {
      if (members.length === 0) continue;
      runs.push({ members, anchor: el });
      members = [];
    } else if (isClassicInline(el)) {
      members.push(el);
    }
  }
  if (members.length > 0) runs.push({ members, anchor: null });
  return runs;
}

/** Undefined for a type the browser never applies as CSS; `media="all"` and an empty title count as none. */
export function cssStyleMergeKey(el: Element): string | undefined {
  const type = el.getAttribute("type") ?? "";
  if (type !== "" && type.toLowerCase() !== "text/css") return undefined;
  const media = (el.getAttribute("media") ?? "").trim().toLowerCase();
  return JSON.stringify([media === "all" ? "" : media, el.getAttribute("title") ?? ""]);
}

/** Groups head styles into runs of adjacent styles with one merge key, so merging a run never reorders rules. */
export function headStyleRuns(
  styles: readonly Element[],
  isPinned: (el: Element) => boolean = () => false,
): Element[][] {
  const runs: Element[][] = [];
  let previousKey: string | undefined;
  for (const el of styles) {
    const key = isPinned(el) ? undefined : cssStyleMergeKey(el);
    if (key !== undefined && key === previousKey) runs.at(-1)!.push(el);
    else if (key !== undefined) runs.push([el]);
    previousKey = key;
  }
  return runs;
}

export function cssKeepingMedia(el: Element, css: string): string {
  const media = (el.getAttribute("media") ?? "").trim();
  return media && media.toLowerCase() !== "all" ? `@media ${media} {\n${css}\n}` : css;
}
