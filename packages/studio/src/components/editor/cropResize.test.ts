// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { prepareCropResize, readCropFollowingResize, saveCropResize } from "./cropResize";
import type { DomEditSelection } from "./domEditingTypes";
import {
  applyStudioBoxSizeDraft,
  captureStudioBoxSize,
  clearStudioBoxSize,
  restoreStudioBoxSize,
} from "./manualEdits";
import { withInlineLayoutBox } from "../../hooks/domSelectionTestHarness";

function sizedElement(width: number, height: number, clip: string): HTMLElement {
  const el = withInlineLayoutBox(document.createElement("div"));
  el.style.cssText = `width: ${width}px; height: ${height}px; clip-path: ${clip}`;
  return el;
}

describe("crop during a resize", () => {
  it("follows the box only while a resize draft is live", () => {
    const el = sizedElement(300, 200, "inset(10px 60px 20px 30px round 8px)");
    const before = captureStudioBoxSize(el);
    const crop = (top: number, right: number, bottom: number, left: number) => ({
      top,
      right,
      bottom,
      left,
      radius: 8,
    });
    applyStudioBoxSizeDraft(el, { width: 600, height: 400 });
    expect(readCropFollowingResize(el)).toEqual(crop(20, 120, 40, 60));
    restoreStudioBoxSize(el, before);
    // An animated width is not a resize: the crop keeps its pixels.
    el.style.width = "600px";
    expect(readCropFollowingResize(el)).toEqual(crop(10, 60, 20, 30));
  });

  it("leaves the crop alone when the box kept its size (a resize saved as scale)", () => {
    const el = sizedElement(300, 200, "inset(0px 60px 0px 0px)");
    applyStudioBoxSizeDraft(el, { width: 450, height: 300 });
    const stage = prepareCropResize(el);
    clearStudioBoxSize(el);
    el.style.width = "300px";
    el.style.height = "200px";
    expect(stage()).toBeNull();
    expect(el.style.getPropertyValue("clip-path")).toBe("inset(0px 60px 0px 0px)");
  });

  it("puts the crop back, !important and all, when its save fails", async () => {
    const el = sizedElement(300, 200, "none");
    el.style.setProperty("clip-path", "inset(0px 60px 0px 0px)", "important");
    const stage = prepareCropResize(el);
    el.style.width = "450px";
    let priorityWhileSaving = "";
    const commit = vi.fn(() => {
      priorityWhileSaving = el.style.getPropertyPriority("clip-path");
      return Promise.reject(new Error("save failed"));
    });
    const selection = { element: el } as unknown as DomEditSelection;
    await expect(saveCropResize(stage, selection, commit, "undo-key")).rejects.toThrow(
      "save failed",
    );

    const value = "inset(0px 90px 0px 0px) !important";
    expect(commit.mock.calls[0]![1]).toEqual([
      { type: "inline-style", property: "clip-path", value },
    ]);
    expect(priorityWhileSaving).toBe("important");
    expect(el.style.getPropertyValue("clip-path")).toBe("inset(0px 60px 0px 0px)");
    expect(el.style.getPropertyPriority("clip-path")).toBe("important");
  });

  it("scales the crop once: the stage ends the draft", () => {
    const el = sizedElement(300, 200, "inset(0px 60px 0px 0px)");
    applyStudioBoxSizeDraft(el, { width: 450, height: 300 });
    prepareCropResize(el)();
    expect(readCropFollowingResize(el)).toMatchObject({ right: 90 });
  });

  it("leaves a crop edited while the size saved, and a tweened crop, alone", () => {
    const edited = sizedElement(300, 200, "inset(0px 60px 0px 0px)");
    const stageEdited = prepareCropResize(edited);
    edited.style.width = "450px";
    edited.style.setProperty("clip-path", "inset(0px 100px 0px 0px)");
    expect(stageEdited()).toBeNull();

    const tweened = sizedElement(300, 200, "inset(0px 60px 0px 0px)");
    const child = { targets: () => [tweened], vars: { clipPath: "inset(0px 120px 0px 0px)" } };
    Object.assign(window, { __timelines: { main: { getChildren: () => [child] } } });
    const stageTweened = prepareCropResize(tweened);
    tweened.style.width = "450px";
    expect(stageTweened()).toBeNull();
    Object.assign(window, { __timelines: undefined });
  });

  it("leaves the crop as authored when the size is tweened, but not when it is only held", () => {
    const stageWith = (child: object) => {
      const el = sizedElement(300, 200, "inset(0px 60px 0px 0px)");
      const timeline = { getChildren: () => [{ targets: () => [el], ...child }] };
      Object.assign(window, { __timelines: { main: timeline } });
      const stage = prepareCropResize(el);
      el.style.width = "450px";
      return stage();
    };
    const keyframes = { "0%": { width: 300 }, "100%": { width: 600 } };
    expect(stageWith({ vars: { keyframes }, duration: () => 4 })).toBeNull();
    expect(stageWith({ vars: { width: 473 }, duration: () => 0 })).not.toBeNull();
    Object.assign(window, { __timelines: undefined });
  });
});
