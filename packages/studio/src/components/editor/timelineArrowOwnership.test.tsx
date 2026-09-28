// @vitest-environment happy-dom
import React, { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installReactActEnvironment, makeSelection } from "../../hooks/domSelectionTestHarness";
import { useDomEditNudge } from "./useDomEditNudge";
import { CANVAS_NUDGE_COMMIT_DEBOUNCE_MS, CANVAS_NUDGE_STEP_PX } from "./domEditNudge";
import type { DomEditSelection } from "./domEditing";
import { __resetForTests } from "../../utils/canvasNudgeGate";
import { usePlaybackKeyboard } from "../../player/hooks/usePlaybackKeyboard";
import { useTimelineKeyboardActor } from "../../player/components/useTimelineKeyboardActor";
import type { TimelineLogicalRow } from "../../player/components/timelineKeyboardNavigation";
import { createTimelineRowGeometry } from "../../player/components/timelineLayout";
import { usePlayerStore } from "../../player/store/playerStore";

installReactActEnvironment();

const ROWS: readonly TimelineLogicalRow[] = [
  {
    id: "track-1",
    kind: "row",
    physicalTrackKey: 1,
    logicalIndex: 0,
    level: 1,
    parentId: null,
    elementId: "box",
    expandable: false,
    expanded: false,
    items: [
      { id: "kf-a", kind: "keyframe", rowId: "track-1", elementId: "box", time: 0 },
      { id: "kf-b", kind: "keyframe", rowId: "track-1", elementId: "box", time: 1 },
    ],
  },
  {
    id: "track-2",
    kind: "row",
    physicalTrackKey: 2,
    logicalIndex: 1,
    level: 1,
    parentId: null,
    elementId: null,
    expandable: false,
    expanded: false,
    items: [],
  },
];
const NO_GROUP: DomEditSelection[] = [];
const ref = <T,>(current: T) => ({ current });

function Studio({
  selection,
  commit,
  seek,
}: {
  selection: DomEditSelection | null;
  commit: () => void;
  seek: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useDomEditNudge({
    selection,
    groupSelections: NO_GROUP,
    allowCanvasMovement: true,
    selectionRef: ref(selection),
    overlayRectRef: ref({ left: 0, top: 0, width: 100, height: 50, editScaleX: 1, editScaleY: 1 }),
    groupOverlayItemsRef: ref([]),
    gestureRef: ref(null),
    groupGestureRef: ref(null),
    blockedMoveRef: ref(null),
    onManualDragStartRef: ref(() => {}),
    onPathOffsetCommitRef: ref(commit),
    onGroupPathOffsetCommitRef: ref(async () => {}),
  });
  const playback = usePlaybackKeyboard({
    iframeRef: useRef(null),
    shuttleDirectionRef: useRef(null),
    shuttleSpeedIndexRef: useRef(0),
    iframeShortcutCleanupRef: useRef(null),
    getAdapter: () => null,
    play: () => {},
    playBackward: () => {},
    pause: () => {},
    seek,
  });
  // Same window capture listener useTimelinePlayer installs.
  React.useEffect(() => {
    const listener = (e: KeyboardEvent) => playback.playbackKeyDownRef.current(e);
    window.addEventListener("keydown", listener, true);
    return () => window.removeEventListener("keydown", listener, true);
  }, [playback.playbackKeyDownRef]);
  const timeline = useTimelineKeyboardActor({
    logicalRows: ROWS,
    focusedTargetId: usePlayerStore((s) => s.timelineFocus?.id ?? null),
    rowGeometry: createTimelineRowGeometry([1, 2], [48, 48]),
    scrollRef,
    onToggleRow: () => {},
  });
  return (
    <>
      <div id="canvas" tabIndex={0} />
      <div data-studio-timeline="true">
        <div ref={scrollRef} onFocus={timeline.onFocus} onKeyDown={timeline.onKeyDown}>
          <div data-timeline-focus-id="track-1" tabIndex={-1} />
          <button type="button" data-timeline-focus-id="kf-a" />
          <button type="button" data-timeline-focus-id="kf-b" />
          <div data-timeline-focus-id="track-2" tabIndex={-1} />
        </div>
      </div>
    </>
  );
}

let root: Root;
let box: HTMLElement;
const commit = vi.fn();
const seek = vi.fn();

function mount(selected: boolean) {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root.render(
      <Studio
        selection={selected ? makeSelection("Box", box) : null}
        commit={commit}
        seek={seek}
      />,
    ),
  );
}

function pressArrowRight(target: HTMLElement) {
  act(() => target.focus());
  const event = new KeyboardEvent("keydown", {
    key: "ArrowRight",
    code: "ArrowRight",
    bubbles: true,
    cancelable: true,
  });
  act(() => target.dispatchEvent(event));
  const pendingTimers = vi.getTimerCount();
  act(() => vi.advanceTimersByTime(CANVAS_NUDGE_COMMIT_DEBOUNCE_MS + 10));
  return pendingTimers;
}

const byFocusId = (id: string) =>
  document.querySelector<HTMLElement>(`[data-timeline-focus-id="${id}"]`)!;

describe("arrow keys on a focused timeline control", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetForTests();
    commit.mockReset();
    seek.mockReset();
    box = document.createElement("div");
    box.id = "box";
    document.body.append(box);
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
    document.body.innerHTML = "";
    usePlayerStore.setState({ timelineFocus: null, timelineFocusNonce: 0 });
  });

  it("moves timeline focus without nudging the selected element or scheduling a write", () => {
    mount(true);
    expect(pressArrowRight(byFocusId("kf-a"))).toBe(0);
    expect(usePlayerStore.getState().timelineFocus?.id).toBe("kf-b");
    expect(commit).not.toHaveBeenCalled();
    expect(seek).not.toHaveBeenCalled();
  });

  it("moves timeline focus without stepping a frame when nothing is selected", () => {
    mount(false);
    pressArrowRight(byFocusId("track-1"));
    expect(usePlayerStore.getState().timelineFocus?.id).toBe("kf-a");
    expect(seek).not.toHaveBeenCalled();
  });

  it("still nudges the selected element when the canvas has focus", () => {
    mount(true);
    pressArrowRight(document.getElementById("canvas")!);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0]![1]).toMatchObject({ x: CANVAS_NUDGE_STEP_PX, y: 0 });
    expect(seek).not.toHaveBeenCalled();
  });

  it("still steps a frame when nothing is selected and the canvas has focus", () => {
    mount(false);
    pressArrowRight(document.getElementById("canvas")!);
    expect(seek).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
  });
});
