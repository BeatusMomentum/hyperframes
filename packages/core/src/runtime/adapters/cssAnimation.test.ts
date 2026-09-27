import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuthoredCssAnimations } from "./cssAnimation";

describe("authored CSS animations", () => {
  // jsdom computes no pseudo-element style; this answers per element and pseudo-element.
  const computedNames = (named: Map<Element, Record<string, string>>) =>
    vi
      .spyOn(window, "getComputedStyle")
      .mockImplementation(
        (el, pseudo) =>
          ({ animationName: named.get(el)?.[pseudo ?? ""] ?? "none" }) as CSSStyleDeclaration,
      );
  const cssAnimation = (
    target: Element,
    animationName: string,
    pseudoElement: string | null = null,
  ) => ({ animationName, effect: { target, pseudoElement } }) as unknown as CSSAnimation;

  const mount = () => {
    document.body.innerHTML = `<div id="a"></div><div id="host"></div>`;
    const a = document.getElementById("a")!;
    const outer = document.getElementById("host")!.attachShadow({ mode: "open" });
    const innerHost = document.createElement("span");
    outer.appendChild(innerHost);
    const inner = innerHost.attachShadow({ mode: "open" });
    const leaf = document.createElement("b");
    inner.appendChild(leaf);
    computedNames(
      new Map([
        [a, { "": "slide, fade", "::after": "pulse" }],
        [leaf, { "": "spin" }],
      ]),
    );
    return { a, leaf, outer, inner };
  };

  // Pseudo-element names matter only where the page lists its animations.
  beforeEach(() => {
    document.getAnimations = () => [];
  });

  afterEach(() => {
    Reflect.deleteProperty(document, "getAnimations");
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("walks the page once, into open shadow roots, reading each element and its ::before/::after", () => {
    const { a, leaf, outer, inner } = mount();
    const authored = createAuthoredCssAnimations();
    const cssAdapterElements: Element[] = [];
    authored.discover((el) => cssAdapterElements.push(el));

    expect(cssAdapterElements).toEqual([a]);
    expect(authored.shadowRoots()).toEqual([outer, inner]);
    const named = [
      cssAnimation(a, "fade"),
      cssAnimation(a, "pulse", "::after"),
      cssAnimation(leaf, "spin"),
    ];
    expect(named.map(authored.has)).toEqual([true, true, true]);
    const others = [
      cssAnimation(a, "pulse"),
      cssAnimation(a, "slide", "::before"),
      cssAnimation(leaf, "slide"),
    ];
    expect(others.map(authored.has)).toEqual([false, false, false]);
  });

  it("gives the CSS adapter only a light-DOM element's own authored animations", () => {
    const { a, leaf } = mount();
    const authored = createAuthoredCssAnimations();
    authored.discover();

    const script = { effect: { target: a, pseudoElement: null } } as unknown as Animation;
    const candidates = [
      cssAnimation(a, "slide"),
      cssAnimation(a, "pulse", "::after"),
      cssAnimation(leaf, "spin"),
      cssAnimation(a, "pulse"),
      script,
    ];
    expect(candidates.map(authored.drivenByCssAdapter)).toEqual([true, false, false, false, false]);
  });

  it("forgets at the next discover what the page no longer names", () => {
    const { a } = mount();
    const authored = createAuthoredCssAnimations();
    authored.discover();
    expect(authored.hasAny()).toBe(true);

    vi.restoreAllMocks();
    computedNames(new Map());
    authored.discover();

    expect([authored.has(cssAnimation(a, "slide")), authored.hasAny()]).toEqual([false, false]);
  });
});
