// @vitest-environment happy-dom

import { afterEach, describe, it, expect, vi } from "vitest";
import {
  applySoftReload,
  applySoftReloadFinalization,
  ensureMotionPathPluginLoaded,
  softReloadSettled,
} from "./gsapSoftReload";

const FILE = {};
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
// What the preview route serves at the iframe's address: the page a fresh load shows.
const served = (html = "<html><body></body></html>") => ({
  location: { href: "http://studio.test/api/projects/p/preview" },
  fetch: vi.fn(async () => ({ ok: true, text: async () => html })),
});
afterEach(() => void (document.body.innerHTML = ""));

const SCRIPT_TEXT = `
window.__timelines = window.__timelines || {};
const tl = gsap.timeline({ paused: true });
tl.to("#box", { opacity: 0.8 });
window.__timelines["root"] = tl;
`;

const MOTION_PATH_SCRIPT_TEXT = `
window.__timelines = window.__timelines || {};
const tl = gsap.timeline({ paused: true });
tl.to("#box", { motionPath: { path: [{ x: 0, y: 0 }, { x: 100, y: 50 }] } });
window.__timelines["root"] = tl;
`;

function buildMockIframe(overrides: Record<string, unknown> = {}) {
  const scriptEl = document.createElement("script");
  scriptEl.textContent =
    'const tl = gsap.timeline({ paused: true }); tl.to("#box", { opacity: 0.5 });';
  const container = document.createElement("div");
  container.appendChild(scriptEl);

  const mockTimeline = { kill: vi.fn(), pause: vi.fn() };
  const contentWindow = {
    gsap: { timeline: vi.fn() },
    __hfForceTimelineRebind: vi.fn(),
    __timelines: { root: mockTimeline } as Record<string, typeof mockTimeline>,
    __player: { getTime: () => 2.0, seek: vi.fn() },
    __hfStudioManualEditsApply: vi.fn(),
    __hfSuppressSceneMutations: undefined as undefined | (<T>(fn: () => T) => T),
    ...served(),
    ...overrides,
  };

  // Intercept appendChild: when a <script> is appended, simulate execution by
  // repopulating __timelines (mimicking what the real GSAP script would do).
  const realAppendChild = container.appendChild.bind(container);
  container.appendChild = <T extends Node>(node: T): T => {
    const result = realAppendChild(node);
    if (node instanceof HTMLScriptElement && node.textContent?.includes("gsap.timeline")) {
      // Simulate the script populating __timelines
      const cw = contentWindow as { __timelines?: Record<string, unknown> };
      if (cw.__timelines) {
        cw.__timelines.root = { kill: vi.fn(), pause: vi.fn() };
      }
    }
    return result;
  };

  const contentDocument = {
    querySelectorAll: (sel: string) => (sel === "script:not([src])" ? [scriptEl] : []),
    createElement: (tag: string) => document.createElement(tag),
    body: container,
    head: document.createElement("div"),
  };

  return {
    iframe: { contentWindow, contentDocument } as unknown as HTMLIFrameElement,
    contentWindow,
    mockTimeline,
    container,
  };
}

describe("applySoftReload", () => {
  it('returns "cannot-soft-reload" when iframe is null', () => {
    expect(applySoftReload(null, SCRIPT_TEXT, FILE)).toBe("cannot-soft-reload");
  });

  it('returns "cannot-soft-reload" when scriptText is empty', () => {
    const { iframe } = buildMockIframe();
    expect(applySoftReload(iframe, "", FILE)).toBe("cannot-soft-reload");
  });

  it('returns "cannot-soft-reload" when gsap is not on iframe window', () => {
    const { iframe } = buildMockIframe({ gsap: undefined });
    expect(applySoftReload(iframe, SCRIPT_TEXT, FILE)).toBe("cannot-soft-reload");
  });

  it('returns "cannot-soft-reload" when __hfForceTimelineRebind is missing', () => {
    const { iframe } = buildMockIframe({ __hfForceTimelineRebind: undefined });
    expect(applySoftReload(iframe, SCRIPT_TEXT, FILE)).toBe("cannot-soft-reload");
  });

  it('returns "cannot-soft-reload" when the script registers no scopable key', () => {
    // No __timelines["key"] pattern → targetKeys is empty → can't scope safely.
    const { iframe } = buildMockIframe();
    expect(applySoftReload(iframe, 'gsap.to("#box", { x: 1 });', FILE)).toBe("cannot-soft-reload");
  });

  it("kills existing timelines, rebinds, and re-seeks on success", async () => {
    const { iframe, contentWindow, mockTimeline } = buildMockIframe();
    const result = applySoftReload(iframe, SCRIPT_TEXT, FILE);
    expect(result).toBe("applied");
    await settle();
    expect(mockTimeline.kill).toHaveBeenCalled();
    expect(contentWindow.__hfForceTimelineRebind).toHaveBeenCalled();
    expect(contentWindow.__player.seek).toHaveBeenCalledWith(2.0);
    expect(contentWindow.__hfStudioManualEditsApply).toHaveBeenCalled();
  });

  it("seeks to the caller-supplied currentTime override instead of the iframe's own __player.getTime()", async () => {
    // Regression: the iframe's raw __player.getTime() (2.0 here, per the mock)
    // can desync from the studio's authoritative scrub position — e.g. a
    // keyframe-node drag parks the playhead via the store before this reload's
    // async commit resolves. The rebuilt timeline must re-seek to the caller's
    // value, not the iframe's possibly-stale one.
    const { iframe, contentWindow } = buildMockIframe();
    const result = applySoftReload(iframe, SCRIPT_TEXT, { ...FILE, currentTimeOverride: 0 });
    expect(result).toBe("applied");
    await settle();
    expect(contentWindow.__player.seek).toHaveBeenCalledWith(0);
  });

  it("reads the page the preview route serves at the iframe's own address", async () => {
    const { iframe, contentWindow } = buildMockIframe();
    applySoftReload(iframe, SCRIPT_TEXT, FILE);
    await settle();
    expect(contentWindow.fetch).toHaveBeenCalledWith(contentWindow.location.href, {
      cache: "no-store",
    });
  });

  it("escalates, touching nothing, when that page cannot be read", async () => {
    const { iframe, contentWindow, mockTimeline } = buildMockIframe({
      fetch: async () => ({ ok: false, text: async () => "" }),
    });
    const onAsyncFailure = vi.fn();
    expect(applySoftReload(iframe, SCRIPT_TEXT, { onAsyncFailure })).toBe("applied");
    await settle();
    expect(onAsyncFailure).toHaveBeenCalledTimes(1);
    expect(mockTimeline.kill).not.toHaveBeenCalled();
    expect(contentWindow.__hfForceTimelineRebind).not.toHaveBeenCalled();
  });

  it("settles once every reload asked so far has applied", async () => {
    const { iframe, contentWindow } = buildMockIframe();
    applySoftReload(iframe, SCRIPT_TEXT, { currentTimeOverride: 1 });
    applySoftReload(iframe, SCRIPT_TEXT, { currentTimeOverride: 2 });
    await softReloadSettled(iframe);
    expect(contentWindow.__player.seek.mock.calls).toEqual([[1], [2]]);
  });

  it("applies reloads in the order they were asked for, whichever page arrives first", async () => {
    const pages: Array<() => void> = [];
    const fetch = () =>
      new Promise((resolve) => pages.push(() => resolve({ ok: true, text: async () => "" })));
    const { iframe, contentWindow } = buildMockIframe({ fetch });
    applySoftReload(iframe, SCRIPT_TEXT, { currentTimeOverride: 1 });
    applySoftReload(iframe, SCRIPT_TEXT, { currentTimeOverride: 2 });
    pages[1]!();
    await settle();
    expect(contentWindow.__player.seek).not.toHaveBeenCalled();
    pages[0]!();
    await settle();
    expect(contentWindow.__player.seek.mock.calls).toEqual([[1], [2]]);
  });

  describe("resets what GSAP parsed in the reloaded composition only", () => {
    async function reloadRoot(body: string, file = "") {
      const doc = document.implementation.createHTMLDocument("");
      doc.body.innerHTML = `${body}<script>${SCRIPT_TEXT}</script>`;
      for (const el of doc.querySelectorAll("[data-gsap]")) Object.assign(el, { _gsap: {} });
      const cleared: Element[] = [];
      const set = (targets: Element[]) => cleared.push(...targets);
      const { iframe } = buildMockIframe({
        gsap: { timeline: vi.fn(), set },
        ...served(`<html><body>${file}</body></html>`),
      });
      Object.assign(iframe, { contentDocument: doc });
      applySoftReload(iframe, SCRIPT_TEXT, FILE);
      await settle();
      return { doc, cleared: cleared.map((el) => el.id) };
    }

    it("resets a standalone gsap.set target even after its inline style was synced away", async () => {
      const { cleared } = await reloadRoot(
        `<div data-composition-id="root"><div id="held" data-gsap></div><div id="plain"></div></div>`,
      );
      expect(cleared).toEqual(["held"]);
    });

    it("strips a stale inline transform from an orphaned (non-timeline-child) element", async () => {
      const { doc } = await reloadRoot(
        `<div data-composition-id="root"><div id="orphan" data-gsap style="left: 1240px; transform: translate(449px, 0px)"></div></div>`,
        `<div id="orphan" style="left: 1240px"></div>`,
      );
      expect(doc.getElementById("orphan")!.style.transform).toBe("");
      expect(doc.getElementById("orphan")!.style.left).toBe("1240px");
    });

    it("leaves what a nested composition's own timeline animates alone, in the preview's inlined markup", async () => {
      // The markup the preview bundler writes for an inlined sub-composition: no data-composition-src left.
      const doc = document.implementation.createHTMLDocument("");
      doc.body.innerHTML =
        `<div data-composition-id="root"><div id="plain" data-hf-id="hf-p"></div>` +
        `<div data-composition-file="compositions/sub.html" data-hf-id="hf-host" id="scene-sub" data-composition-id="sub">` +
        `<div style="width:1920px;height:400px" data-hf-inner-root="true" data-hf-authored-id="sub" data-hf-id="hf-in">` +
        `<div id="nsty" data-hf-id="hf-n" style="left: 420px; background: #f0f040; transform: translate(0px, 30px)"></div>` +
        `</div></div></div><script>${SCRIPT_TEXT}</script>`;
      const [plain, nsty] = [doc.getElementById("plain")!, doc.getElementById("nsty")!];
      const subTween = { targets: () => [nsty] };
      const sub = { getChildren: () => [subTween] };
      const own = { targets: () => [plain] };
      const root = {
        kill: vi.fn(),
        getChildren: (deep: boolean) => (deep ? [sub, subTween, own] : [sub, own]),
      };
      const cleared: Element[] = [];
      const { iframe } = buildMockIframe({
        gsap: { timeline: vi.fn(), set: (targets: Element[]) => cleared.push(...targets) },
        __timelines: { root, sub },
        ...served(`<html><body><div id="plain"></div></body></html>`),
      });
      Object.assign(iframe, { contentDocument: doc });
      applySoftReload(iframe, SCRIPT_TEXT, FILE);
      await settle();
      expect(cleared).toEqual([plain]);
      expect(nsty.getAttribute("style")).toBe(
        "left: 420px; background: #f0f040; transform: translate(0px, 30px)",
      );
    });

    it("leaves a nested composition's element alone: its script is not re-run", async () => {
      const { doc, cleared } = await reloadRoot(
        `<div data-composition-id="root"><div id="host" data-composition-id="sub" data-gsap>` +
          `<div id="nested" data-gsap style="transform: translate(90px, 60px)"></div></div></div>`,
      );
      expect(cleared).toEqual(["host"]);
      expect(doc.getElementById("nested")!.style.transform).toBe("translate(90px, 60px)");
    });
  });

  it('returns "cannot-soft-reload" when the live page has no GSAP script to replace', () => {
    const { iframe } = buildMockIframe();
    const doc = document.implementation.createHTMLDocument("");
    Object.assign(iframe, { contentDocument: doc });
    expect(applySoftReload(iframe, SCRIPT_TEXT, FILE)).toBe("cannot-soft-reload");
    expect(applySoftReload(iframe, SCRIPT_TEXT, { ...FILE, bootstrap: "added" })).not.toBe(
      "cannot-soft-reload",
    );
  });

  it("wraps execution in __hfSuppressSceneMutations when available", async () => {
    let suppressionCalled = false;
    const { iframe } = buildMockIframe({
      __hfSuppressSceneMutations: <T>(fn: () => T): T => {
        suppressionCalled = true;
        return fn();
      },
    });
    const result = applySoftReload(iframe, SCRIPT_TEXT, FILE);
    expect(result).toBe("applied");
    await settle();
    expect(suppressionCalled).toBe(true);
  });

  it("the re-run re-registers the script's expected key", async () => {
    const { iframe, contentWindow } = buildMockIframe();
    expect(applySoftReload(iframe, SCRIPT_TEXT, FILE)).toBe("applied");
    await settle();
    expect(contentWindow.__timelines.root).toBeDefined();
  });

  it("editing composition A leaves composition B's timeline intact (scoped kill)", async () => {
    // Two comps live side by side; the soft reload only re-runs comp "root".
    // Comp "subscene" must survive untouched — the regression the full remount
    // (re-inline) used to cause.
    const subsceneTimeline = { kill: vi.fn(), pause: vi.fn() };
    const { iframe, contentWindow, mockTimeline } = buildMockIframe({
      __timelines: {
        root: { kill: vi.fn(), pause: vi.fn() },
        subscene: subsceneTimeline,
      } as Record<string, { kill: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn> }>,
    });
    void mockTimeline;

    expect(applySoftReload(iframe, SCRIPT_TEXT, FILE)).toBe("applied");
    await settle();
    // Comp B was never killed and is still registered.
    expect(subsceneTimeline.kill).not.toHaveBeenCalled();
    expect(contentWindow.__timelines.subscene).toBe(subsceneTimeline);
  });

  it("runs without an async plugin load when MotionPathPlugin is already present", async () => {
    // The preview bootstrap pre-loads MotionPathPlugin, so win.MotionPathPlugin
    // is set before any motion-path edit. The soft reload must then execute the
    // script inline — no CDN <script> appended to <head>.
    const headAppends: Node[] = [];
    const head = document.createElement("div");
    const realHeadAppend = head.appendChild.bind(head);
    head.appendChild = <T extends Node>(node: T): T => {
      headAppends.push(node);
      return realHeadAppend(node);
    };
    const { iframe, contentWindow } = buildMockIframe({ MotionPathPlugin: {} });
    (iframe.contentDocument as unknown as { head: unknown }).head = head;

    const result = applySoftReload(iframe, MOTION_PATH_SCRIPT_TEXT, FILE);

    expect(result).toBe("applied");
    await settle();
    // No CDN plugin <script> was appended to <head> — ran inline.
    expect(headAppends.filter((n) => n instanceof HTMLScriptElement)).toHaveLength(0);
    expect(contentWindow.__hfForceTimelineRebind).toHaveBeenCalled();
    expect(contentWindow.__player.seek).toHaveBeenCalledWith(2.0);
    expect(contentWindow.__timelines.root).toBeDefined();
  });

  it("falls back to the async plugin load when MotionPathPlugin is genuinely absent", async () => {
    const head = document.createElement("div");
    const appendedScripts: HTMLScriptElement[] = [];
    const realHeadAppend = head.appendChild.bind(head);
    head.appendChild = <T extends Node>(node: T): T => {
      if (node instanceof HTMLScriptElement) appendedScripts.push(node);
      return realHeadAppend(node);
    };
    // gsap present but MotionPathPlugin unset → async load path.
    const { iframe, contentWindow } = buildMockIframe({
      MotionPathPlugin: undefined,
      gsap: { timeline: vi.fn(), registerPlugin: vi.fn() },
    });
    (iframe.contentDocument as unknown as { head: unknown }).head = head;

    const onAsyncFailure = vi.fn();
    const result = applySoftReload(iframe, MOTION_PATH_SCRIPT_TEXT, { ...FILE, onAsyncFailure });

    // Optimistically "applied" (script will run once the plugin loads) — and the
    // script has NOT executed yet, so the timeline isn't rebound synchronously.
    expect(result).toBe("applied");
    await settle();
    expect(appendedScripts).toHaveLength(1);
    expect(appendedScripts[0]!.src).toContain("MotionPathPlugin");
    expect(contentWindow.__hfForceTimelineRebind).not.toHaveBeenCalled();

    // onerror must NOT run the script (that would reference a missing plugin) —
    // it escalates via onAsyncFailure so the caller can full-reload to recover,
    // and clears the in-flight loading flag.
    appendedScripts[0]!.onerror?.(new Event("error"));
    expect(onAsyncFailure).toHaveBeenCalledTimes(1);
    expect(contentWindow.__hfForceTimelineRebind).not.toHaveBeenCalled();
    expect(contentWindow.__hfMotionPathPluginLoading).toBe(false);
  });

  it('returns "cannot-soft-reload" when multiple GSAP scripts exist (ambiguous)', () => {
    const script1 = document.createElement("script");
    script1.textContent = "const tl = gsap.timeline({ paused: true });";
    const script2 = document.createElement("script");
    script2.textContent = 'tl.to("#other", { x: 10 });';
    const container = document.createElement("div");
    container.appendChild(script1);
    container.appendChild(script2);

    const { iframe } = buildMockIframe();
    (iframe as unknown as { contentDocument: unknown }).contentDocument = {
      querySelectorAll: (sel: string) => (sel === "script:not([src])" ? [script1, script2] : []),
      createElement: (tag: string) => document.createElement(tag),
      body: container,
    };
    // Multiple scripts, none registering "root" → can't identify what to replace
    // → structural failure that genuinely needs a full reload.
    expect(applySoftReload(iframe, SCRIPT_TEXT, FILE)).toBe("cannot-soft-reload");
  });
});

// ── Finalization-only path: seek → rebind → manual edits, with NO script
// execution — the flashless sync for timing edits that changed no script.
describe("applySoftReloadFinalization", () => {
  it("seeks, rebinds, and reapplies manual edits without touching any script", () => {
    const { iframe, contentWindow, container, mockTimeline } = buildMockIframe();
    const scriptsBefore = container.querySelectorAll("script").length;

    expect(applySoftReloadFinalization(iframe, 2.0)).toBe(true);

    expect(contentWindow.__player.seek).toHaveBeenCalledWith(2.0);
    expect(contentWindow.__hfForceTimelineRebind).toHaveBeenCalledTimes(1);
    expect(contentWindow.__hfStudioManualEditsApply).toHaveBeenCalledTimes(1);
    // No script executed or removed; the live timeline was never killed.
    expect(container.querySelectorAll("script").length).toBe(scriptsBefore);
    expect(mockTimeline.kill).not.toHaveBeenCalled();
    expect(contentWindow.__timelines.root).toBe(mockTimeline);
  });

  it("runs inside __hfSuppressSceneMutations when the runtime provides it", () => {
    const suppress = vi.fn(<T>(fn: () => T): T => fn());
    const { iframe, contentWindow } = buildMockIframe({
      __hfSuppressSceneMutations: suppress,
    });

    expect(applySoftReloadFinalization(iframe, 1.5)).toBe(true);

    expect(suppress).toHaveBeenCalledTimes(1);
    expect(contentWindow.__hfForceTimelineRebind).toHaveBeenCalledTimes(1);
  });

  it("does NOT require gsap — a script-less runtime with the rebind hook works", () => {
    const { iframe, contentWindow } = buildMockIframe({ gsap: undefined });
    expect(applySoftReloadFinalization(iframe, 0)).toBe(true);
    expect(contentWindow.__hfForceTimelineRebind).toHaveBeenCalledTimes(1);
  });

  it("returns false when the iframe or the rebind hook is unavailable", () => {
    expect(applySoftReloadFinalization(null, 0)).toBe(false);
    const { iframe } = buildMockIframe({ __hfForceTimelineRebind: undefined });
    expect(applySoftReloadFinalization(iframe, 0)).toBe(false);
  });

  it("returns false when the rebind throws (caller full-reloads)", () => {
    const { iframe } = buildMockIframe({
      __hfForceTimelineRebind: vi.fn(() => {
        throw new Error("runtime mid-teardown");
      }),
    });
    expect(applySoftReloadFinalization(iframe, 0)).toBe(false);
  });
});

function buildBootstrapIframe(overrides: Record<string, unknown> = {}) {
  const head = document.createElement("div");
  const appendedScripts: HTMLScriptElement[] = [];
  const realHeadAppend = head.appendChild.bind(head);
  head.appendChild = <T extends Node>(node: T): T => {
    if (node instanceof HTMLScriptElement) appendedScripts.push(node);
    return realHeadAppend(node);
  };

  const registerPlugin = vi.fn();
  const contentWindow = {
    gsap: { registerPlugin } as Record<string, unknown> | undefined,
    MotionPathPlugin: undefined as unknown,
    __hfMotionPathPluginLoading: undefined as boolean | undefined,
    ...overrides,
  };
  const contentDocument = {
    createElement: (tag: string) => document.createElement(tag),
    head,
  };
  return {
    iframe: { contentWindow, contentDocument } as unknown as HTMLIFrameElement,
    contentWindow,
    appendedScripts,
    registerPlugin,
  };
}

describe("ensureMotionPathPluginLoaded", () => {
  it("no-ops when the iframe is null", () => {
    expect(() => ensureMotionPathPluginLoaded(null)).not.toThrow();
  });

  it("no-ops when gsap is unavailable", () => {
    const { iframe, appendedScripts } = buildBootstrapIframe({ gsap: undefined });
    ensureMotionPathPluginLoaded(iframe);
    expect(appendedScripts).toHaveLength(0);
  });

  it("appends the plugin script once and registers it on load", () => {
    const { iframe, contentWindow, appendedScripts, registerPlugin } = buildBootstrapIframe();
    ensureMotionPathPluginLoaded(iframe);
    expect(appendedScripts).toHaveLength(1);
    expect(appendedScripts[0]!.src).toContain("MotionPathPlugin");
    expect(contentWindow.__hfMotionPathPluginLoading).toBe(true);

    // Simulate the CDN load completing; the plugin is now present.
    contentWindow.MotionPathPlugin = {};
    appendedScripts[0]!.onload?.(new Event("load"));
    expect(registerPlugin).toHaveBeenCalledWith(contentWindow.MotionPathPlugin);
    expect(contentWindow.__hfMotionPathPluginLoading).toBe(false);
  });

  it("is idempotent: a second call while loading does not append a second script", () => {
    const { iframe, appendedScripts } = buildBootstrapIframe();
    ensureMotionPathPluginLoaded(iframe);
    ensureMotionPathPluginLoaded(iframe);
    expect(appendedScripts).toHaveLength(1);
  });

  it("registers an already-present plugin without appending a script", () => {
    const plugin = {};
    const { iframe, appendedScripts, registerPlugin } = buildBootstrapIframe({
      MotionPathPlugin: plugin,
    });
    ensureMotionPathPluginLoaded(iframe);
    expect(appendedScripts).toHaveLength(0);
    expect(registerPlugin).toHaveBeenCalledWith(plugin);
  });

  it("clears the loading flag and still resolves when the CDN load errors", () => {
    const { iframe, contentWindow, appendedScripts } = buildBootstrapIframe();
    ensureMotionPathPluginLoaded(iframe);
    appendedScripts[0]!.onerror?.(new Event("error"));
    expect(contentWindow.__hfMotionPathPluginLoading).toBe(false);
    // A subsequent call can retry (plugin still absent, flag cleared).
    ensureMotionPathPluginLoaded(iframe);
    expect(appendedScripts).toHaveLength(2);
  });
});

// Undo and commits must leave each element as a fresh load of the preview shows it.
describe("applySoftReload restores each element's inline style from a fresh load", () => {
  function buildIframeWithTarget(
    el: Element,
    fresh: string,
    overrides: Record<string, unknown> = {},
  ) {
    let top = el;
    while (top.parentElement) top = top.parentElement;
    document.body.appendChild(top);
    const scriptEl = document.createElement("script");
    scriptEl.textContent =
      'const tl = gsap.timeline({ paused: true }); tl.to("#box", { opacity: 0.5 });';
    const tl = {
      kill: vi.fn(),
      pause: vi.fn(),
      getChildren: () => [{ targets: () => [el] }],
    };
    const contentWindow = {
      gsap: { timeline: vi.fn(), set: vi.fn() },
      __hfForceTimelineRebind: vi.fn(),
      __timelines: { root: tl } as Record<string, unknown>,
      __player: { getTime: () => 2.0, seek: vi.fn() },
      __hfStudioManualEditsApply: vi.fn(),
      ...served(fresh),
      ...overrides,
    };
    const container = document.createElement("div");
    container.appendChild(scriptEl);
    // Intercept only POST-SETUP appends: simulate the re-run script
    // repopulating __timelines (as in buildMockIframe).
    const realAppendChild = container.appendChild.bind(container);
    container.appendChild = <T extends Node>(node: T): T => {
      const result = realAppendChild(node);
      if (node instanceof HTMLScriptElement && node.textContent?.includes("gsap.timeline")) {
        contentWindow.__timelines.root = { kill: vi.fn(), pause: vi.fn() };
      }
      return result;
    };
    const contentDocument = {
      querySelectorAll: (sel: string) => (sel === "script:not([src])" ? [scriptEl] : []),
      createElement: (tag: string) => document.createElement(tag),
      body: container,
      head: document.createElement("div"),
    };
    return { iframe: { contentWindow, contentDocument } as unknown as HTMLIFrameElement };
  }

  const page = (body: string) => `<html><body>${body}</body></html>`;

  it("gives an element exactly the style attribute a fresh load gives it", async () => {
    const el = document.createElement("img");
    el.setAttribute("data-hf-id", "hf-1");
    el.setAttribute(
      "style",
      "opacity: 0 !important; translate: none; transform: translate(9px, 9px); visibility: visible",
    );
    const { iframe } = buildIframeWithTarget(
      el,
      page(`<img data-hf-id="hf-1" style="opacity: 0.98; translate: 60px 40px">`),
    );
    expect(applySoftReload(iframe, SCRIPT_TEXT, FILE)).toBe("applied");
    await settle();
    expect(el.getAttribute("style")).toBe("opacity: 0.98; translate: 60px 40px");
  });

  it.each([
    { who: "a fresh load writes no inline style for", tag: "div", id: "box" },
    { who: "a script created (the re-run recreates its state)", tag: "span", id: "" },
  ])("leaves no inline style on an element $who", async ({ tag, id }) => {
    const el = document.createElement(tag);
    el.id = id;
    el.setAttribute("style", "opacity: 0.4213; translate: none; transform: translate(9px, 9px)");
    const { iframe } = buildIframeWithTarget(el, page(`<div id="box"></div>`));
    applySoftReload(iframe, SCRIPT_TEXT, FILE);
    await settle();
    expect(el.hasAttribute("style")).toBe(false);
  });

  it("keeps an SVG child's authored inline transform", async () => {
    const el = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    el.setAttribute("data-hf-id", "hf-1");
    el.setAttribute("style", "transform: translate(9px, 9px) rotate(20deg)");
    const { iframe } = buildIframeWithTarget(
      el,
      page(`<svg><rect data-hf-id="hf-1" style="transform: rotate(20deg)"></rect></svg>`),
    );
    applySoftReload(iframe, SCRIPT_TEXT, FILE);
    await settle();
    expect(el.style.transform).toBe("rotate(20deg)");
  });

  it("full-reloads rather than restyle what may be a plain template's clone", async () => {
    const el = document.createElement("li");
    el.id = "item";
    el.setAttribute("style", "opacity: 0.3");
    const { iframe } = buildIframeWithTarget(
      el,
      page(`<template><li id="item" style="opacity: 1"></li></template>`),
    );
    const onAsyncFailure = vi.fn();
    applySoftReload(iframe, SCRIPT_TEXT, { onAsyncFailure });
    await settle();
    expect(onAsyncFailure).toHaveBeenCalledTimes(1);
    expect(el.getAttribute("style")).toBe("opacity: 0.3");
  });

  it("keeps soft reloads for a script-made node unlike any plain template's content", async () => {
    const el = document.createElement("span");
    el.setAttribute("style", "opacity: 0.3");
    const onAsyncFailure = vi.fn();
    const { iframe } = buildIframeWithTarget(
      el,
      page(`<template><li class="row"></li></template><div id="box"></div>`),
    );
    applySoftReload(iframe, SCRIPT_TEXT, { onAsyncFailure });
    await settle();
    expect(onAsyncFailure).not.toHaveBeenCalled();
    expect(el.hasAttribute("style")).toBe(false);
  });

  it("full-reloads when a script copy shares its source's id, since which is which is unknown", async () => {
    const el = document.createElement("div");
    el.setAttribute("data-hf-id", "hf-1");
    const copy = el.cloneNode() as Element;
    const { iframe } = buildIframeWithTarget(el, page(`<div data-hf-id="hf-1"></div>`));
    document.body.appendChild(copy);
    const onAsyncFailure = vi.fn();
    applySoftReload(iframe, SCRIPT_TEXT, { onAsyncFailure });
    await settle();
    expect(onAsyncFailure).toHaveBeenCalledTimes(1);
  });

  // The inlined markup the preview bundler writes: sizes on the flattened root, asset urls re-pointed.
  const INLINED = (host: string, inner: string, img: string) =>
    `<div data-composition-file="compositions/sub.html" data-hf-id="hf-host" data-composition-id="sub" style="${host}">` +
    `<div data-hf-inner-root="true" data-hf-id="hf-in" style="${inner}">` +
    `<img data-hf-id="hf-img" style="${img}"></div></div>`;

  it("gives a nested composition's elements what the preview bundler wrote for them", async () => {
    const fresh = INLINED(
      "left: 300px",
      "width:1920px;height:400px",
      "left: 12px; background: url(compositions/a.png)",
    );
    const holder = document.createElement("div");
    holder.innerHTML = INLINED(
      "left: 300px; transform: translateY(9px)",
      "width:1920px;height:400px;opacity:0.5",
      "left: 12px; width: 345px; background: url(compositions/a.png)",
    );
    const targets = [...holder.querySelectorAll("[data-hf-id]")];
    const { iframe } = buildIframeWithTarget(targets[2]!, page(fresh), {
      __timelines: { root: { kill: vi.fn(), getChildren: () => [{ targets: () => targets }] } },
    });
    applySoftReload(iframe, SCRIPT_TEXT, FILE);
    await settle();
    expect(targets.map((el) => el.getAttribute("style"))).toEqual([
      "left: 300px",
      "width:1920px;height:400px",
      "left: 12px; background: url(compositions/a.png)",
    ]);
  });

  it("runs the caller's step right before the reset, in the same task", async () => {
    const el = document.createElement("div");
    el.id = "box";
    const order: string[] = [];
    const { iframe } = buildIframeWithTarget(el, page(`<div id="box"></div>`), {
      gsap: { timeline: vi.fn(), set: () => order.push("reset") },
    });
    applySoftReload(iframe, SCRIPT_TEXT, { beforeReset: () => order.push("sync") });
    expect(order).toEqual([]);
    await settle();
    expect(order).toEqual(["sync", "reset"]);
  });

  it("the finalize seek cannot paint the killed timeline over the restored transform", async () => {
    const el = document.createElement("div");
    el.style.cssText = "translate: none; transform: translate3d(77.5px, 40px, 0px)";
    const children = [{ targets: () => [el] }];
    const killed = {
      kill: vi.fn(),
      getChildren: () => children,
      clear: () => void children.splice(0),
    };
    // The runtime still seeks the timeline it captured at load until the rebind swaps it.
    const seek = () =>
      children.forEach(() => (el.style.transform = "translate3d(77.5px, 0px, 0px)"));
    let transformAtRebind: string | null = null;
    const { iframe } = buildIframeWithTarget(el, page(""), {
      __timelines: { root: killed },
      __player: { getTime: () => 1, seek },
      __hfForceTimelineRebind: () => (transformAtRebind = el.style.transform),
    });
    applySoftReload(iframe, SCRIPT_TEXT, FILE);
    await settle();
    expect(transformAtRebind).toBe("");
  });
});
