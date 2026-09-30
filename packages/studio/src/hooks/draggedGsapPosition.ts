/**
 * Drag → GSAP position math, shared by the commit path
 * (`gsapDragCommit.commitGsapPositionFromDrag` / `commitStaticGsapPosition`) and
 * the live preview (`manualOffsetDrag.applyManualOffsetDrag*`). Kept in its own
 * leaf module — no store/runtime/core imports — so the live-preview file can use
 * it without pulling the GSAP commit graph into its module scope.
 */

import { roundTo3 } from "../utils/rounding";

const cssValue = (style: CSSStyleDeclaration, prop: string) => {
  const value = style.getPropertyValue(prop).trim();
  return value === "none" ? "" : value;
};

function transformTranslation(view: Window & typeof globalThis, list: string) {
  const matrix = list ? new view.DOMMatrix(list) : null;
  return { x: matrix?.m41 ?? 0, y: matrix?.m42 ?? 0 };
}

// GSAP writes `translate rotate scale transform` as one inline transform; a value the browser rejects
// (e.g. `rotate: x 30deg`) drops the whole string, leaving GSAP only the plain transform.
function foldedTranslation(view: Window & typeof globalThis, style: CSSStyleDeclaration) {
  const [tx = "", ty = ""] = cssValue(style, "translate").split(/\s+/);
  const rotate = cssValue(style, "rotate");
  const scale = cssValue(style, "scale");
  const transform = cssValue(style, "transform");
  const folded = [
    rotate && `rotate(${rotate})`,
    scale && `scale(${scale.split(/\s+/).join(",")})`,
    transform,
  ];
  try {
    return { tx, ty, ...transformTranslation(view, folded.join(" ").trim()) };
  } catch {
    return { tx: "", ty: "", ...transformTranslation(view, transform) };
  }
}

function foldedAxis(translate: string, fromTransform: number, size: number) {
  const raw = Number.parseFloat(translate) || 0;
  const t = (translate.endsWith("%") ? (raw * size) / 100 : raw) + fromTransform;
  const centered = t !== 0 && Math.round(size / 2) === Math.round(-t);
  return { value: centered ? t + size / 2 : t, percent: centered ? -50 : 0, fromTransform };
}

function readCssFold(element: HTMLElement, view: Window & typeof globalThis) {
  const moved = foldedTranslation(view, view.getComputedStyle(element));
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

// Without GSAP, the inline `translate` that shows x/y where the committed `gsap.set` will. Null with GSAP.
export function cssTranslateForGsapPosition(
  element: HTMLElement,
): ((x: number, y: number) => string) | null {
  const view = element.ownerDocument.defaultView as GsapView | null;
  if (!view || typeof view.gsap?.getProperty === "function") return null;
  const { x: ax, y: ay } = readCssFold(element, view);
  return (x, y) =>
    `calc(${ax.percent}% + ${x - ax.fromTransform}px) calc(${ay.percent}% + ${y - ay.fromTransform}px)`;
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
