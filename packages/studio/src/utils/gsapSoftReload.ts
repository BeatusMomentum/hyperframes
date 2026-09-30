import { isCompositionTemplate } from "@hyperframes/parsers/hf-ids";

type IframeWindow = Window & {
  __timelines?: Record<string, { kill?: () => void; pause?: () => void }>;
  __player?: { getTime?: () => number; seek?: (t: number) => void };
  __hfForceTimelineRebind?: () => void;
  __hfSuppressSceneMutations?: <T>(fn: () => T) => T;
  __hfStudioManualEditsApply?: () => void;
  // Set while a MotionPathPlugin <script> is being fetched, so overlapping soft
  // reloads (each needing the plugin) don't queue duplicate plugin scripts that
  // re-flash the iframe. Cleared once the plugin loads or errors.
  __hfMotionPathPluginLoading?: boolean;
  gsap?: {
    timeline?: (...args: unknown[]) => unknown;
    registerPlugin?: (...plugins: unknown[]) => unknown;
    set?: (targets: Element | Element[], vars: Record<string, unknown>) => void;
    globalTimeline?: { getChildren?: (deep: boolean) => Array<{ kill?: () => void }> };
  };
  MotionPathPlugin?: unknown;
};

/**
 * CDN URL for the GSAP MotionPathPlugin. Shared between the one-time preview
 * bootstrap (ensureMotionPathPluginLoaded) and the soft-reload fallback so the
 * version is pinned in a single place.
 */
const MOTION_PATH_PLUGIN_CDN =
  "https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/MotionPathPlugin.min.js";

/**
 * Pre-load + register MotionPathPlugin ONCE in the preview iframe so
 * `win.MotionPathPlugin` is reliably set before any studio edit. Called from the
 * preview bootstrap (NLELayout's onIframeLoad) on every iframe load.
 *
 * Why: when a user ADDS a motion path to a composition that never used one, the
 * plugin isn't loaded, so the first soft reload takes the async `<script src>`
 * load path — the timeline is killed/cleared while the CDN load is pending,
 * producing a visible flash. Loading it eagerly here means the soft reload runs
 * synchronously and `needsMotionPath && !win.MotionPathPlugin` never fires for
 * studio edits.
 *
 * Idempotent (no-ops once the plugin is present or already loading) and
 * defensive: no-ops without gsap/registerPlugin and tolerates a CDN failure
 * (the soft-reload async fallback in applySoftReload still covers that case).
 */
export function ensureMotionPathPluginLoaded(iframe: HTMLIFrameElement | null): void {
  if (!iframe?.contentWindow || !iframe.contentDocument) return;
  const win = iframe.contentWindow as IframeWindow;
  const doc = iframe.contentDocument;

  // Already registered (composition shipped its own plugin, or a prior bootstrap
  // ran) — register it on gsap to be safe, then bail.
  if (win.MotionPathPlugin) {
    try {
      if (win.gsap?.registerPlugin) win.gsap.registerPlugin(win.MotionPathPlugin);
    } catch {}
    return;
  }
  if (!win.gsap?.registerPlugin) return;
  // A load is already in flight for this iframe — don't queue a second script.
  if (win.__hfMotionPathPluginLoading) return;

  try {
    win.__hfMotionPathPluginLoading = true;
    const pluginScript = doc.createElement("script");
    pluginScript.src = MOTION_PATH_PLUGIN_CDN;
    const finalize = () => {
      win.__hfMotionPathPluginLoading = false;
      try {
        if (win.MotionPathPlugin && win.gsap?.registerPlugin) {
          win.gsap.registerPlugin(win.MotionPathPlugin);
        }
      } catch {}
    };
    pluginScript.onload = finalize;
    pluginScript.onerror = finalize;
    doc.head.appendChild(pluginScript);
  } catch {
    win.__hfMotionPathPluginLoading = false;
  }
}

function isGsapScript(text: string): boolean {
  return (
    text.includes("gsap.timeline") ||
    text.includes("__timelines") ||
    text.includes(".to(") ||
    text.includes(".set(")
  );
}

export function findGsapScriptElements(doc: Document): HTMLScriptElement[] {
  const results: HTMLScriptElement[] = [];
  const scripts = doc.querySelectorAll<HTMLScriptElement>("script:not([src])");
  for (const script of scripts) {
    if (isGsapScript(script.textContent || "")) results.push(script);
  }
  return results;
}

/**
 * Extract the GSAP timeline script text from a serialized HTML document, for
 * feeding into applySoftReload. Returns null when zero or multiple GSAP scripts
 * are present (ambiguous — a serialized snapshot can't say WHICH script a
 * single rewritten text corresponds to; caller should fall back to a full
 * reload), matching applySoftReload's own single-script requirement.
 */
export function extractGsapScriptText(html: string): string | null {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const scripts = findGsapScriptElements(doc);
  if (scripts.length !== 1) return null;
  return scripts[0].textContent || null;
}

// The preview route serves the bundled document a fresh load shows; null when it cannot be read.
async function readFreshPreview(win: IframeWindow): Promise<Document | null> {
  try {
    const res = await win.fetch(win.location.href, { cache: "no-store" });
    return res.ok ? new DOMParser().parseFromString(await res.text(), "text/html") : null;
  } catch {
    return null;
  }
}

// The element's style attribute in a fresh load; undefined when the page cannot say which element it is.
function freshInlineStyle(fresh: Document, el: Element): string | null | undefined {
  const attr = el.hasAttribute("data-hf-id") ? "data-hf-id" : "id";
  const value = el.getAttribute(attr);
  if (!value) return null;
  const selector = `[${attr}="${CSS.escape(value)}"]`;
  const loaded = fresh.querySelectorAll(selector);
  if (loaded.length === 0) return null;
  const live = [...el.ownerDocument.querySelectorAll(selector)];
  // A script's copies share their source's ids, so which is the loaded one is unknown.
  if (loaded.length !== live.length) return undefined;
  return loaded[live.indexOf(el)]!.getAttribute("style");
}

function compositionRoot(doc: Document, key: string): Element | undefined {
  return [...doc.querySelectorAll("[data-composition-id]")].find(
    (el) => el.getAttribute("data-composition-id") === key,
  );
}

// A script's clone of a plain template's element is not in the page; only a full load rebuilds it.
function mayBeTemplateClone(fresh: Document, el: Element): boolean {
  if (freshInlineStyle(fresh, el) !== null) return false;
  return [...fresh.querySelectorAll("template")].some(
    (t) =>
      !isCompositionTemplate(t) &&
      [...t.content.querySelectorAll("*")].some(
        (c) => c.tagName === el.tagName && [...c.classList].every((k) => el.classList.contains(k)),
      ),
  );
}

type TimelineLike = {
  kill?: () => void;
  clear?: () => void;
  getChildren?: (deep: boolean) => Array<TimelineLike & { targets?: () => Element[] }>;
};

function resetToFresh(win: IframeWindow, fresh: Document, targets: Element[]): void {
  if (targets.length === 0 || !win.gsap?.set) return;
  try {
    win.gsap.set(targets, { clearProps: "all" });
  } catch {}
  for (const el of targets) {
    const style = freshInlineStyle(fresh, el);
    if (style) el.setAttribute("style", style);
    else el.removeAttribute("style");
  }
}

// A nested composition's timeline belongs to its own script, which this re-run neither rebuilds nor resets.
function ownTweenTargets(tl: TimelineLike | undefined, nested: Set<unknown>): Element[] {
  return (tl?.getChildren?.(false) ?? []).flatMap((child) => {
    if (nested.has(child)) return [];
    return child.getChildren ? ownTweenTargets(child, nested) : (child.targets?.() ?? []);
  });
}

function timelineTargets(win: IframeWindow, key: string): Element[] {
  const timelines: Record<string, unknown> = win.__timelines ?? {};
  const nested = new Set(Object.keys(timelines).flatMap((k) => (k === key ? [] : [timelines[k]])));
  try {
    return ownTweenTargets(timelines[key] as TimelineLike | undefined, nested);
  } catch {
    return [];
  }
}

function collectTargets(win: IframeWindow, doc: Document, keys: string[]): Element[] {
  const targets = keys.flatMap((key) => [
    ...timelineTargets(win, key),
    ...gsapParsedInOwnComposition(doc, key),
  ]);
  return [...new Set(targets)];
}

function planReset(win: IframeWindow, doc: Document, keys: string[], fresh: Document) {
  const targets = collectTargets(win, doc, keys);
  const rebuildable = targets.every(
    (el) => freshInlineStyle(fresh, el) !== undefined && !mayBeTemplateClone(fresh, el),
  );
  return rebuildable ? targets : null;
}

function gsapParsedInOwnComposition(doc: Document, key: string): Element[] {
  const comp = compositionRoot(doc, key);
  if (!comp) return [];
  return [comp, ...comp.querySelectorAll("*")].filter(
    (el) =>
      "_gsap" in el && (el === comp || el.parentElement?.closest("[data-composition-id]") === comp),
  );
}

/**
 * Outcome of a soft-reload attempt:
 *
 * - `"applied"`            — the reload is queued and WILL run once the fresh page
 *                            is read. A failure from then on (the page cannot be
 *                            read or matched, the plugin load or the re-run fails)
 *                            is surfaced via `onAsyncFailure`.
 * - `"cannot-soft-reload"` — PERMANENT/STRUCTURAL: no gsap runtime, no rebind
 *                            hook, no scopable target key, or no live script to
 *                            replace (unless `bootstrap: "added"`) → escalate.
 */
export type SoftReloadResult = "applied" | "cannot-soft-reload";

/**
 * Replace the GSAP script in the live iframe without reloading. This preserves
 * the WebGL context and shader transition cache.
 *
 * Scoped to root-document GSAP scripts only — scripts inside `<template>`
 * elements (sub-compositions) are not visible to `querySelectorAll` and will
 * fall back to a full iframe reload.
 *
 * Every element the re-run rebuilds gets the inline style a fresh load of the
 * preview gives it, so the reload first reads the page the preview route serves.
 * Reloads apply in call order. `onAsyncFailure` is the full-reload escalation for
 * everything that fails after this returned `"applied"`.
 */
export interface SoftReloadOptions {
  /** Escalation for failures after "applied": the fresh page, the plugin load or the re-run. */
  onAsyncFailure?: () => void;
  /** Seek target for the rebuilt timeline; defaults to the iframe player time. */
  currentTimeOverride?: number;
  /** A first edit's GSAP bootstrap: "added" may run with no live script, "removed" tears down and runs nothing. */
  bootstrap?: "added" | "removed";
  /** Runs right before the reset, in the same task, so no frame shows it without the reset. */
  beforeReset?: () => void;
}

/**
 * The soft reload's finalization step, shared with the rebind-only preview sync
 * below: seek → force timeline rebind → reapply studio manual edits.
 *
 * Seek BEFORE rebind: __hfForceTimelineRebind's own internal force-render
 * (see init.ts) renders the freshly-created timeline at whatever the
 * runtime's internal scrub position already is, not at whatever we pass
 * here afterward — a redundant seek() call after rebind can be a GSAP
 * no-op if the timeline already reports being at that time internally.
 */
function finalizeSoftReload(win: IframeWindow, currentTime: number): void {
  win.__player?.seek?.(currentTime);
  win.__hfForceTimelineRebind?.();
  win.__hfStudioManualEditsApply?.();
}

/**
 * Run ONLY applySoftReload's finalization (seek → __hfForceTimelineRebind →
 * manual-edits reapply) against the live iframe — executing NO scripts and
 * touching NO script elements. `__hfForceTimelineRebind` makes the runtime
 * re-derive every clip's visibility window from the live DOM's `data-start` /
 * `data-duration` attributes (init.ts: bindRootTimelineIfAvailable +
 * syncTimedElementVisibility), so this is the flashless sync for a timing edit
 * whose attributes were already live-patched and whose GSAP scripts are
 * unchanged (`window.__timelines` still valid). Works for compositions with
 * zero GSAP scripts too — the rebind hook is installed unconditionally by the
 * runtime, independent of any animation library.
 *
 * Returns false when the iframe/runtime hook is unavailable or the run threw —
 * the caller should escalate to a full reload.
 */
export function applySoftReloadFinalization(
  iframe: HTMLIFrameElement | null,
  currentTime: number,
): boolean {
  const win = iframe?.contentWindow as IframeWindow | null;
  if (!win?.__hfForceTimelineRebind) return false;
  try {
    if (win.__hfSuppressSceneMutations) {
      win.__hfSuppressSceneMutations(() => finalizeSoftReload(win, currentTime));
    } else {
      finalizeSoftReload(win, currentTime);
    }
    return true;
  } catch {
    return false;
  }
}

function scopeScript(doc: Document, scriptText: string, bootstrap: SoftReloadOptions["bootstrap"]) {
  // Which composition(s) does this script rebuild? A soft reload re-runs ONE
  // composition's GSAP script, which re-registers its own window.__timelines[key].
  // In a multi-composition preview (top-level + inlined subcompositions) each
  // composition owns a separate timeline keyed by its id, and they're all children
  // of the global timeline — so tearing down ALL of them (or the global timeline's
  // children) and re-running a single script wipes every OTHER composition,
  // reverting its edits. Scope the teardown to the keys THIS script re-registers.
  const targetKeys = [...scriptText.matchAll(/__timelines\s*\[\s*["'`]([^"'`]+)["'`]\s*\]/g)]
    .map((m) => m[1]!)
    .filter((key) => key !== "__proxied");
  if (targetKeys.length === 0) return null; // can't scope safely → full reload
  const gsapScripts = findGsapScriptElements(doc);
  if (gsapScripts.length === 0 && bootstrap !== "added") return null;
  // Remove only the stale script element(s) that registered a target key; one we
  // can't match in the doc is left alone (re-running appends a fresh element).
  const staleScripts = gsapScripts.filter((script) =>
    targetKeys.some((key) => {
      const text = script.textContent || "";
      return text.includes(`__timelines["${key}"]`) || text.includes(`__timelines['${key}']`);
    }),
  );
  // Multiple GSAP scripts exist but none registers a key this script owns — we
  // can't identify which element to replace (ambiguous, matching
  // extractGsapScriptText's single-script requirement). Escalate to a full reload
  // rather than killing the target timeline and appending an orphan script.
  if (gsapScripts.length > 1 && staleScripts.length === 0) return null;
  return { targetKeys, staleScripts };
}

const pendingReloads = new WeakMap<object, Promise<void>>();

export function applySoftReload(
  iframe: HTMLIFrameElement | null,
  scriptText: string,
  options: SoftReloadOptions,
): SoftReloadResult {
  const { bootstrap } = options;
  if (!iframe || !scriptText) return "cannot-soft-reload";

  const win = iframe.contentWindow as IframeWindow | null;
  const doc = iframe.contentDocument;
  if (!win || !doc) return "cannot-soft-reload";
  if (!win.gsap || !win.__hfForceTimelineRebind) return "cannot-soft-reload";
  if (!scopeScript(doc, scriptText, bootstrap)) return "cannot-soft-reload";

  // Prefer the caller-supplied scrub position (the studio's own authoritative
  // currentTime, e.g. usePlayerStore) over the iframe's raw `__player.getTime()`:
  // the two can desync (a keyframe-node drag parks the playhead via the store
  // BEFORE this reload's async commit resolves, and the iframe's own GSAP clock
  // doesn't reliably reflect that yet), which re-seeks the freshly rebuilt
  // timeline to the wrong frame and leaves the element (and its overlay)
  // rendered at a stale/unrelated position.
  const currentTime = options.currentTimeOverride ?? win.__player?.getTime?.() ?? 0;
  const fresh = readFreshPreview(win);
  const queued = (pendingReloads.get(win) ?? Promise.resolve())
    .then(() => fresh)
    .then((page) => runSoftReload(win, doc, scriptText, options, currentTime, page))
    .catch(() => options.onAsyncFailure?.());
  pendingReloads.set(win, queued);
  return "applied";
}

/** Settles once every soft reload asked of this preview so far has applied or escalated; read the preview after it. */
export function softReloadSettled(iframe: HTMLIFrameElement | null): Promise<void> {
  const win = iframe?.contentWindow;
  return (win && pendingReloads.get(win)) || Promise.resolve();
}

// fallow-ignore-next-line complexity
function runSoftReload(
  win: IframeWindow,
  doc: Document,
  scriptText: string,
  options: SoftReloadOptions,
  currentTime: number,
  fresh: Document | null,
): void {
  const { onAsyncFailure, bootstrap, beforeReset } = options;
  // Scoped again here: an earlier queued reload may have replaced the script elements.
  const scope = scopeScript(doc, scriptText, bootstrap);
  const targets = scope && fresh && planReset(win, doc, scope.targetKeys, fresh);
  if (!scope || !fresh || !targets) {
    onAsyncFailure?.();
    return;
  }
  const { targetKeys, staleScripts } = scope;

  const doReload = () => {
    beforeReset?.();
    const timelines = win.__timelines;

    // Kill ONLY the target composition's timeline(s) — leaving every other
    // composition's timeline (and its children on the global timeline) intact.
    if (timelines) {
      for (const key of targetKeys) {
        const tl = timelines[key] as TimelineLike | undefined;
        if (!tl) continue;
        try {
          // kill() keeps the children, and the finalize seek renders this timeline until the rebind swaps it.
          tl.clear?.();
          tl.kill?.();
        } catch {}
        delete timelines[key];
      }
    }

    resetToFresh(win, fresh, targets);

    for (const script of staleScripts) script.remove();
    if (bootstrap === "removed") {
      finalizeSoftReload(win, currentTime);
      return;
    }

    const executeScript = () => {
      if (win.MotionPathPlugin && win.gsap?.registerPlugin) {
        win.gsap.registerPlugin(win.MotionPathPlugin);
      }
      const s = doc.createElement("script");
      s.textContent = `(function(){${scriptText}\n})();`;
      doc.body.appendChild(s);
      finalizeSoftReload(win, currentTime);
    };

    const needsMotionPath = /motionPath\s*[:{]/.test(scriptText);
    if (needsMotionPath && !win.MotionPathPlugin && win.gsap) {
      // A prior soft reload is already fetching the plugin — don't queue a second
      // <script> (it re-flashes the iframe). Defer THIS script's execution until
      // the in-flight load settles via a one-shot poll. The bootstrap guard is
      // the single source of truth for "plugin fetch in progress".
      if (win.__hfMotionPathPluginLoading) {
        const started = Date.now();
        const poll = win.setInterval(() => {
          if (win.MotionPathPlugin) {
            win.clearInterval(poll);
            executeScript();
          } else if (!win.__hfMotionPathPluginLoading || Date.now() - started > 10000) {
            // The in-flight load finished without registering the plugin (errored)
            // or we timed out — recover with a full reload instead of running a
            // script that references a missing plugin.
            win.clearInterval(poll);
            onAsyncFailure?.();
          }
        }, 50);
        return;
      }
      win.__hfMotionPathPluginLoading = true;
      const pluginScript = doc.createElement("script");
      pluginScript.src = MOTION_PATH_PLUGIN_CDN;
      pluginScript.onload = () => {
        win.__hfMotionPathPluginLoading = false;
        executeScript();
      };
      pluginScript.onerror = () => {
        // The plugin failed to load. Running executeScript() now would leave the
        // iframe with a motionPath tween referencing a missing plugin. Signal
        // failure so the caller can full-reload (which fetches the plugin fresh).
        win.__hfMotionPathPluginLoading = false;
        onAsyncFailure?.();
      };
      doc.head.appendChild(pluginScript);
      return;
    }

    executeScript();
  };

  try {
    if (win.__hfSuppressSceneMutations) {
      win.__hfSuppressSceneMutations(doReload);
    } else {
      doReload();
    }
  } catch {
    // The re-run threw — the preview is now genuinely broken (target timeline
    // killed, script not re-registered). Escalate to a full reload.
    onAsyncFailure?.();
  }
}
