// Drag-path and sequence cases (gsap none): a path is one long move, a sequence is several edits with no settle between.
// Ids keep the grid's scheme with one letters-only gesture token, so `^[a-z]+-none-` selects them.

const MOVE = { do: "drag", gesture: "move", by: [90, 60] };
const BACK = { do: "drag", gesture: "move", by: [-70, 50] };
const UP = { do: "drag", gesture: "move", by: [60, -80] };

const PATHS = ["zigzag", "circle", "flick", "pause", "edge"];

/** Each sequence's steps; a drag names its element (A is #target, B is #other) and its screen-px path. */
const SEQUENCES = {
  repeat: [MOVE, BACK, UP],
  undo: [MOVE, { do: "undo" }, BACK],
  nudge: [MOVE, { do: "nudge", count: 3 }, BACK],
  ab: [MOVE, { ...BACK, element: "B" }, { ...UP, element: "A" }],
  resize: [{ do: "drag", gesture: "resize" }, MOVE],
  seek: [{ do: "seek", time: 2 }, MOVE],
  // Pressed again in the frame after pointer-up, while that drag's save is still in flight.
  inflight: [MOVE, { ...BACK, inFlight: true }],
  // Undone at once, before the edit's save lands: the undo must win.
  resizeundo: [{ do: "drag", gesture: "resize" }, { do: "undo" }],
  nudgeundo: [{ do: "nudge", count: 1 }, { do: "undo" }],
  rotatenudge: [
    { do: "drag", gesture: "rotate" },
    { do: "nudge", count: 3 },
  ],
};

/** Text in place: a double press opens it, Enter commits; `select` first double-clicks a word to replace. */
const TEXT = {
  edit: [{ do: "text", word: "Teleport" }],
  select: [{ do: "text", word: "Teleport", select: "accuracy" }],
};

const row = (gesture, c, steps) => ({
  id: [gesture, "none", c.placement, `r${c.rotation}`, c.nesting, `z${c.zoom}`].join("-"),
  gesture,
  gsap: "none",
  ...c,
  steps,
  other: Boolean(steps?.some((s) => s.element === "B")),
});

const base = { rotation: 0, zoom: 100 };
const everyPlacement = ["px", "pct", "center"].flatMap((placement) =>
  ["root", "nested"].map((nesting) => ({ ...base, placement, nesting })),
);
const pxRoot = (extra) => ({ ...base, placement: "px", nesting: "root", ...extra });

export function dragCases() {
  const route = (path) => [{ do: "drag", gesture: "move", route: path }];
  const paths = PATHS.flatMap((p) =>
    [...everyPlacement, pxRoot({ rotation: 30 }), pxRoot({ zoom: 50 }), pxRoot({ zoom: 200 })].map(
      (c) => row(`path${p}`, c, route(p)),
    ),
  );
  const sequences = Object.entries(SEQUENCES).flatMap(([name, steps]) =>
    everyPlacement.map((c) => row(`seq${name}`, c, steps)),
  );
  const texts = Object.entries(TEXT).flatMap(([name, steps]) =>
    ["root", "nested"].map((nesting) => ({
      ...row(`text${name}`, { ...base, placement: "px", nesting }, steps),
      text: true,
    })),
  );
  // Rotate on the common centring idiom, a transform rather than the translate property.
  const centred = [0, 30].flatMap((rotation) =>
    ["root", "nested"].map((nesting) => ({
      ...row("rotate", { ...base, rotation, placement: "transform", nesting }, undefined),
      steps: undefined,
      other: false,
    })),
  );
  // A page that loads GSAP and tweens a different element: the target is still a plain CSS element.
  const page = ["move", "nudge", "resize", "rotate"].flatMap((gesture) =>
    ["px", "center"].flatMap((placement) =>
      ["root", "nested"].map((nesting) => ({
        id: [gesture, "page", placement, "r0", nesting, "z100"].join("-"),
        gesture,
        gsap: "page",
        ...base,
        placement,
        nesting,
        other: true,
      })),
    ),
  );
  return [...paths, ...sequences, ...texts, ...centred, ...page];
}
