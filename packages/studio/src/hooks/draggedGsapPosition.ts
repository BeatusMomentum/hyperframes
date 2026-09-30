/**
 * Drag → GSAP position math, shared by the commit path
 * (`gsapDragCommit.commitGsapPositionFromDrag` / `commitStaticGsapPosition`) and
 * the live preview (`manualOffsetDrag.applyManualOffsetDrag*`). Kept in its own
 * leaf module — no store/runtime/core imports — so the live-preview file can use
 * it without pulling the GSAP commit graph into its module scope.
 */

import { splitTopLevelWhitespace } from "../components/editor/manualEditsStyleHelpers";
import { roundTo3 } from "../utils/rounding";

const cssValue = (style: CSSStyleDeclaration, prop: string) => {
  const value = style.getPropertyValue(prop).trim();
  return value === "none" ? "" : value;
};

function transformOf(view: Window & typeof globalThis, list: string) {
  const m = list ? new view.DOMMatrix(list) : null;
  return {
    x: m?.m41 ?? 0,
    y: m?.m42 ?? 0,
    rotation: m ? (Math.atan2(m.b, m.a) * 180) / Math.PI : 0,
  };
}

// GSAP writes `translate rotate scale transform` as one inline transform; a value the browser rejects
// (e.g. `rotate: x 30deg`) drops the whole string, leaving GSAP only the plain transform.
function foldedTransform(
  view: Window & typeof globalThis,
  style: CSSStyleDeclaration,
  withRotate = true,
) {
  const [tx = "", ty = ""] = splitTopLevelWhitespace(cssValue(style, "translate"));
  const rotate = withRotate ? cssValue(style, "rotate") : "";
  const scale = cssValue(style, "scale");
  const transform = cssValue(style, "transform");
  const folded = [
    rotate && `rotate(${rotate})`,
    scale && `scale(${scale.split(/\s+/).join(",")})`,
    transform,
  ];
  try {
    return { tx, ty, ...transformOf(view, folded.join(" ").trim()) };
  } catch {
    return { tx: "", ty: "", ...transformOf(view, transform) };
  }
}

// One `translate` axis as percent + px: a length, or the draft's `calc()`, which computed style keeps.
function translateTerms(token: string) {
  const terms = { pct: 0, px: 0, calc: token.startsWith("calc(") };
  for (const [, op, num, unit] of token.matchAll(/([+-]?)\s*(-?[\d.]+(?:e[+-]?\d+)?)(%|px)/g)) {
    const value = op === "-" ? -Number(num) : Number(num);
    if (unit === "%") terms.pct += value;
    else terms.px += value;
  }
  return terms;
}

// GSAP keeps a -50% centring as xPercent, which scales with a resize. `kept` is what the stylesheet
// transform goes on drawing under the draft: a transform that alone centres the box keeps its -50%.
function foldedAxis(translate: string, fromTransform: number, size: number) {
  const half = Math.round(size / 2);
  const kept =
    fromTransform !== 0 && half === Math.round(-fromTransform)
      ? { percent: -50, px: fromTransform + size / 2 }
      : { percent: 0, px: fromTransform };
  const { pct, px, calc } = translateTerms(translate);
  const percent = pct + kept.percent;
  if (calc && (percent === 0 || percent === -50)) return { value: px + kept.px, percent, kept };
  const t = (pct * size) / 100 + px + fromTransform;
  const centered = t !== 0 && half === Math.round(-t);
  return { value: centered ? t + size / 2 : t, percent: centered ? -50 : 0, kept };
}

function readCssFold(element: HTMLElement, view: Window & typeof globalThis) {
  const moved = foldedTransform(view, view.getComputedStyle(element));
  return {
    x: foldedAxis(moved.tx, moved.x, element.offsetWidth),
    y: foldedAxis(moved.ty, moved.y, element.offsetHeight),
  };
}

type GsapView = Window &
  typeof globalThis & { gsap?: { getProperty?: (el: Element, p: string) => unknown } };

// The GSAP x/y every position gesture and commit starts from. Without GSAP, what its CSSPlugin will
// parse once the commit loads it: `translate`, `rotate`, `scale`, `transform`, less a -50% centring.
export function readGsapPosition(element: HTMLElement): { x: number; y: number } {
  const view = element.ownerDocument.defaultView as GsapView | null;
  if (!view) return { x: 0, y: 0 };
  const getProperty = view.gsap?.getProperty;
  if (getProperty) {
    return { x: Number(getProperty(element, "x")), y: Number(getProperty(element, "y")) };
  }
  const fold = readCssFold(element, view);
  return { x: fold.x.value, y: fold.y.value };
}

// Without GSAP, the rotation GSAP will parse from the CSS `rotate`, `scale` and `transform`; with
// `withRotate` false, only the part `scale` and `transform` draw.
export function readCssRotation(element: HTMLElement, withRotate = true): number {
  const view = element.ownerDocument.defaultView as GsapView | null;
  return view ? foldedTransform(view, view.getComputedStyle(element), withRotate).rotation : 0;
}

// Without GSAP, the inline `translate` that shows x/y where the committed `gsap.set` will. Null with GSAP.
export function cssTranslateForGsapPosition(
  element: HTMLElement,
): ((x: number, y: number) => string) | null {
  const view = element.ownerDocument.defaultView as GsapView | null;
  if (!view || typeof view.gsap?.getProperty === "function") return null;
  const { x: ax, y: ay } = readCssFold(element, view);
  const axis = (a: typeof ax, v: number) =>
    `calc(${a.percent - a.kept.percent}% + ${v - a.kept.px}px)`;
  return (x, y) => `${axis(ax, x)} ${axis(ay, y)}`;
}

/**
 * Translate a studio drag offset into absolute GSAP x/y, accounting for the
 * element's rotation and its drag-start base pose. Reads the drag-start
 * attributes stamped by `createManualOffsetDragMember`
 * (`data-hf-drag-initial-offset-*`, `data-hf-drag-gsap-base-*`); `fallbackBase`
 * is used when the base attributes are absent (e.g. a static element that GSAP
 * hasn't given an x/y yet).
 *
 * Used by both the tweened commit and the static `set` commit / live preview, so
 * the preview and the committed value agree by construction.
 */
// fallow-ignore-next-line complexity
export function computeDraggedGsapPosition(
  element: HTMLElement,
  studioOffset: { x: number; y: number },
  fallbackBase: { x: number; y: number },
): { newX: number; newY: number; baseGsapX: number; baseGsapY: number } {
  const rotStyle = element.style.getPropertyValue("--hf-studio-rotation");
  const rotDeg = Number.parseFloat(rotStyle) || 0;
  const rad = (-rotDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const origX = Number.parseFloat(element.getAttribute("data-hf-drag-initial-offset-x") ?? "") || 0;
  const origY = Number.parseFloat(element.getAttribute("data-hf-drag-initial-offset-y") ?? "") || 0;
  const deltaX = studioOffset.x - origX;
  const deltaY = studioOffset.y - origY;
  const adjX = deltaX * cos - deltaY * sin;
  const adjY = deltaX * sin + deltaY * cos;
  const parsedBaseX = Number.parseFloat(element.getAttribute("data-hf-drag-gsap-base-x") ?? "");
  const parsedBaseY = Number.parseFloat(element.getAttribute("data-hf-drag-gsap-base-y") ?? "");
  const baseGsapX = Number.isFinite(parsedBaseX) ? parsedBaseX : fallbackBase.x;
  const baseGsapY = Number.isFinite(parsedBaseY) ? parsedBaseY : fallbackBase.y;
  return {
    newX: roundTo3(baseGsapX + adjX),
    newY: roundTo3(baseGsapY + adjY),
    baseGsapX,
    baseGsapY,
  };
}
