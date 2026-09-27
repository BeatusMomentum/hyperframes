// Names escape commas and CSS whitespace (`n\,\ m`); a hex escape eats one space (`\35 `).
export const splitNames = (list: string) =>
  list.match(/(?:\\[\da-fA-F]{1,6}[ \t\n\r\f]?|\\.|[^ \t\n\r\f,\\])+/g) ?? [];

/**
 * The CSS animations the page authored: the names in each element's computed style at discover, which
 * outlives display:none and escapes each name. One a class adds or swaps in later is not authored.
 */
export function createAuthoredCssAnimations() {
  let names = new WeakMap<Element, Set<string>>();
  let anyNames = false;
  return {
    /** Starts a discover: forgets what the last one recorded. */
    reset: () => {
      names = new WeakMap();
      anyNames = false;
    },
    record: (element: Element, style: CSSStyleDeclaration) => {
      names.set(element, new Set(splitNames(style.animationName)));
      anyNames = true;
    },
    has: (animation: CSSAnimation): boolean => {
      const target = (animation.effect as KeyframeEffect | null)?.target;
      const name = animation.animationName;
      const set = target ? names.get(target) : undefined;
      // A name that is also a keyword reads quoted (`"none"`).
      return !!set && (set.has(globalThis.CSS?.escape?.(name) ?? name) || set.has(`"${name}"`));
    },
    hasAny: () => anyNames,
  };
}

export type AuthoredCssAnimations = ReturnType<typeof createAuthoredCssAnimations>;
