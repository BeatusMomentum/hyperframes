import { isHtmlElement } from "../domRealm";

/** A CSSAnimation from any realm: CSS transitions and script animations have no animationName. */
export const isCssAnimation = (animation: Animation): animation is CSSAnimation =>
  "animationName" in animation;

// Names escape commas and CSS whitespace (`n\,\ m`); a hex escape eats one space (`\35 `).
export const splitNames = (list: string) =>
  list.match(/(?:\\[\da-fA-F]{1,6}[ \t\n\r\f]?|\\.|[^ \t\n\r\f,\\])+/g) ?? [];

/**
 * The clip a CSS animation on `element` belongs to: the nearest `[data-start]` ancestor-or-self,
 * walking out of shadow trees to the outermost host first.
 */
export function cssClip(element: Element): Element {
  let owner = element;
  for (let root = owner.getRootNode(); root.nodeType === 11 && "host" in root; ) {
    owner = (root as ShadowRoot).host;
    root = owner.getRootNode();
  }
  return owner.closest("[data-start]") ?? owner;
}

export function clipStartSeconds(
  clip: Element,
  resolveStartSeconds?: (element: Element) => number,
): number {
  return resolveStartSeconds
    ? resolveStartSeconds(clip)
    : Number.parseFloat(clip.getAttribute("data-start") ?? "0") || 0;
}

type OnCssAdapterElement = (el: HTMLElement, style: CSSStyleDeclaration) => void;

/**
 * The CSS animations the page authored: the names in the computed style of each element and its
 * ::before/::after at discover, which outlives display:none and escapes each name.
 */
export function createAuthoredCssAnimations() {
  let names = new WeakMap<Element, Set<string>>();
  let cssAdapterElements = new WeakSet<Element>();
  let shadowRoots: ShadowRoot[] = [];
  let anyNames = false;

  const record = (element: Element, pseudo: string, style: CSSStyleDeclaration) => {
    const list = style.animationName === "none" ? [] : splitNames(style.animationName || "");
    if (!list.length) return false;
    const set = names.get(element) ?? new Set<string>();
    for (const name of list) set.add(`${pseudo} ${name}`);
    names.set(element, set);
    anyNames = true;
    return true;
  };

  const walk = (
    scope: Document | ShadowRoot,
    pseudos: string[],
    onCssAdapterElement: OnCssAdapterElement,
  ) => {
    for (const el of scope.querySelectorAll("*")) {
      const style = window.getComputedStyle(el);
      if (record(el, "", style) && scope === document && isHtmlElement(el)) {
        cssAdapterElements.add(el);
        onCssAdapterElement(el, style);
      }
      for (const pseudo of pseudos) record(el, pseudo, window.getComputedStyle(el, pseudo));
      if (el.shadowRoot) {
        shadowRoots.push(el.shadowRoot);
        walk(el.shadowRoot, pseudos, onCssAdapterElement);
      }
    }
  };

  const has = (animation: CSSAnimation): boolean => {
    const effect = animation.effect as KeyframeEffect | null;
    const name = animation.animationName;
    const set = effect?.target ? names.get(effect.target) : undefined;
    const pseudo = effect?.pseudoElement ?? "";
    // A name that is also a keyword reads quoted (`"none"`).
    const escaped = globalThis.CSS?.escape?.(name) ?? name;
    return !!set && (set.has(`${pseudo} ${escaped}`) || set.has(`${pseudo} "${name}"`));
  };

  return {
    /** One walk of the page and its open shadow roots, in the CSS adapter's discover: run it first. */
    discover: (onCssAdapterElement: OnCssAdapterElement = () => {}) => {
      names = new WeakMap();
      cssAdapterElements = new WeakSet();
      shadowRoots = [];
      anyNames = false;
      // Only getAnimations() reaches a pseudo-element's animation (jsdom has neither).
      const pseudos = typeof document.getAnimations === "function" ? ["::before", "::after"] : [];
      walk(document, pseudos, onCssAdapterElement);
    },
    shadowRoots: () => shadowRoots,
    has,
    hasAny: () => anyNames,
    /** Never both: the CSS adapter drives authored animations of light-DOM elements, WAAPI the rest. */
    drivenByCssAdapter: (animation: Animation): boolean => {
      const effect = animation.effect as KeyframeEffect | null;
      const own =
        !!effect?.target && !effect.pseudoElement && cssAdapterElements.has(effect.target);
      return own && isCssAnimation(animation) && has(animation);
    },
  };
}

export type AuthoredCssAnimations = ReturnType<typeof createAuthoredCssAnimations>;
