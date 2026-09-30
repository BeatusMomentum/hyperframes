import type { PatchOperation } from "../../utils/sourcePatcher";
import type { CommitMutation } from "../../hooks/gsapScriptCommitTypes";
import type { DomEditSelection } from "./domEditingTypes";
import { gsapAnimatesProperty, gsapTweensProperty } from "./gsapAnimatesProperty";
import { buildInsetClipPathSides, type ParsedInsetClipPathSides } from "./clipPathHelpers";
import { hasCropInsets, readElementCropInsets } from "./domEditOverlayCrop";
import { forgetStudioBoxSizeDraftBase, readStudioBoxSizeDraftBase } from "./manualEditsDom";

interface Box {
  width: number;
  height: number;
}

const boxOf = (element: HTMLElement): Box => ({
  width: element.offsetWidth,
  height: element.offsetHeight,
});

function scaleCrop(crop: ParsedInsetClipPathSides, from: Box, to: Box): ParsedInsetClipPathSides {
  const sx = from.width > 0 ? to.width / from.width : 1;
  const sy = from.height > 0 ? to.height / from.height : 1;
  return {
    top: crop.top * sy,
    right: crop.right * sx,
    bottom: crop.bottom * sy,
    left: crop.left * sx,
    radius: crop.radius,
  };
}

/** The element's crop as the crop UI draws it: it follows the box while a resize draft is live. */
export function readCropFollowingResize(element: HTMLElement): ParsedInsetClipPathSides | null {
  const crop = readElementCropInsets(element);
  const base = readStudioBoxSizeDraftBase(element);
  return crop && base ? scaleCrop(crop, base, boxOf(element)) : crop;
}

export interface CropResize {
  patch: PatchOperation;
  revert: () => void;
}

/** Call before a resize lands. Once the new size is live, the stage writes the crop that keeps the
 *  same part of the element in view and returns its patch, or null when nothing needs rescaling. */
export function prepareCropResize(element: HTMLElement): () => CropResize | null {
  const from = readStudioBoxSizeDraftBase(element) ?? boxOf(element);
  const before = element.style.getPropertyValue("clip-path");
  const priority = element.style.getPropertyPriority("clip-path");
  // A crop is left as authored when GSAP drives the clip, or tweens the size it is measured against.
  const owned =
    gsapAnimatesProperty(element, "clipPath") || gsapTweensProperty(element, "width", "height");
  const crop = owned ? null : readElementCropInsets(element);
  return () => {
    forgetStudioBoxSizeDraftBase(element);
    const to = boxOf(element);
    // A crop edited while the size saved was drawn in the new box already.
    const untouched = element.style.getPropertyValue("clip-path") === before;
    if (!crop || !hasCropInsets(crop) || !untouched || !(to.width > 0 && to.height > 0))
      return null;
    if (to.width === from.width && to.height === from.height) return null;
    const clip = buildInsetClipPathSides(scaleCrop(crop, from, to), crop.radius);
    element.style.setProperty("clip-path", clip, priority);
    return {
      patch: {
        type: "inline-style",
        property: "clip-path",
        value: priority ? `${clip} !important` : clip,
      },
      revert: () => {
        if (before) element.style.setProperty("clip-path", before, priority);
        else element.style.removeProperty("clip-path");
      },
    };
  };
}

type PatchCommit = (
  selection: DomEditSelection,
  patches: PatchOperation[],
  options: { label: string; coalesceKey: string; coalesceMs?: number },
) => Promise<void>;

/** Stage the crop and save it under the resize's undo key, taking it back off the element if that fails. */
export async function saveCropResize(
  stage: () => CropResize | null,
  selection: DomEditSelection,
  commit: PatchCommit,
  coalesceKey: string,
): Promise<void> {
  const crop = stage();
  if (!crop) return;
  try {
    await commit(selection, [crop.patch], {
      label: "Resize layer",
      coalesceKey,
      coalesceMs: Number.POSITIVE_INFINITY,
    });
  } catch (error) {
    crop.revert();
    throw error;
  }
}

let sizeWriteCounter = 0;

/** A property write that may size the element (a W/H field on an animated element): when it
 *  does, its writes and the rescaled crop share one undo step. */
export async function writeSizeWithCrop(
  selection: DomEditSelection,
  properties: Record<string, unknown>,
  mutation: CommitMutation | null,
  commit: PatchCommit,
  write: (keyed?: CommitMutation) => Promise<void>,
): Promise<void> {
  if (!mutation || !("width" in properties || "height" in properties)) return write();
  const stage = prepareCropResize(selection.element);
  const coalesceKey = `size-write:${++sizeWriteCounter}`;
  const undoStep = { coalesceKey, coalesceMs: Number.POSITIVE_INFINITY };
  const keyed: CommitMutation = (s, m, options) => mutation(s, m, { ...options, ...undoStep });
  if (mutation.batch) {
    const batch = mutation.batch;
    keyed.batch = (calls, options) => batch(calls, { ...options, ...undoStep });
  }
  await write(keyed);
  await saveCropResize(stage, selection, commit, coalesceKey);
}
