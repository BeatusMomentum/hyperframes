/**
 * Checks whether GSAP actively animates one or more CSS/GSAP properties on
 * the given element by inspecting all registered `__timelines`.
 */
export function gsapAnimatesProperty(el: HTMLElement, ...props: string[]): boolean {
  return findGsapWrite(el, props, false);
}

/** Like gsapAnimatesProperty, but only tweens that run over time count, not instant holds. */
export function gsapTweensProperty(el: HTMLElement, ...props: string[]): boolean {
  return findGsapWrite(el, props, true);
}

// fallow-ignore-next-line complexity
function findGsapWrite(el: HTMLElement, props: string[], tweensOnly: boolean): boolean {
  const win = el.ownerDocument.defaultView as
    | (Window & {
        __timelines?: Record<
          string,
          {
            getChildren?: (deep: boolean) => Array<{
              targets?: () => Element[];
              vars?: Record<string, unknown>;
              duration?: () => number;
            }>;
          }
        >;
      })
    | null;
  if (!win?.__timelines) return false;
  const propSet = new Set(props);
  for (const tl of Object.values(win.__timelines)) {
    if (!tl?.getChildren) continue;
    try {
      for (const child of tl.getChildren(true)) {
        if (!child.targets || !child.vars) continue;
        if (tweensOnly && !((child.duration?.() ?? 0) > 0)) continue;
        let targetsEl = false;
        for (const t of child.targets()) {
          if (t === el || (el.id && t.id === el.id)) {
            targetsEl = true;
            break;
          }
        }
        if (!targetsEl) continue;
        const vars = child.vars;
        for (const p of propSet) {
          if (p in vars) return true;
        }
        if (vars.keyframes && typeof vars.keyframes === "object") {
          for (const kfVal of Object.values(vars.keyframes as Record<string, unknown>)) {
            if (kfVal && typeof kfVal === "object") {
              for (const p of propSet) {
                if (p in (kfVal as Record<string, unknown>)) return true;
              }
            }
          }
        }
      }
    } catch {
      /* */
    }
  }
  return false;
}
