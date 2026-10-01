import { describe, expect, it } from "vitest";
import { scoreTeleport } from "./teleport.mjs";
import { entry, score } from "./report.mjs";

// The composition root drawn 1:1 at the origin, and a 100 px box whose centre the pointer holds.
const root = [
  [0, 0],
  [1920, 0],
  [1920, 1080],
  [0, 1080],
];
const box = (x, y = 0) => [
  [x, y],
  [x + 100, y],
  [x + 100, y + 100],
  [x, y + 100],
];
/** The pointer at `px`, the box drawn at `bx` (default: under the pointer). */
const frame = (px, down, bx = px, by = 0) => ({
  t: px,
  pointer: [px + 50, 50],
  down,
  root,
  quad: box(bx, by),
  size: [100, 100],
  clip: "none",
});
const steps = (n, size) => Array.from({ length: n }, (_, i) => (i + 1) * size);
const drag = [
  frame(0, false),
  frame(0, true),
  ...steps(5, 10).map((x) => frame(x, true)),
  frame(50, false),
];

describe("scoreTeleport", () => {
  it("passes a box that follows the pointer every frame", () => {
    expect(scoreTeleport("move", drag)).toMatchObject({ max: 0, pass: true });
  });

  it("passes a box drawn one frame late", () => {
    const late = drag.map((f, i) => (i > 1 ? frame(f.t, f.down, drag[i - 1].t) : f));
    expect(scoreTeleport("move", [...late, frame(50, false)]).pass).toBe(true);
  });

  it("catches a mid-drag snap back to where the drag started, on the pointer's own path", () => {
    const snapped = drag.map((f, i) => (i === 4 ? frame(30, true, 0) : f));
    const r = scoreTeleport("move", snapped);
    expect(r).toMatchObject({ kind: "jump", pass: false });
    expect(r.trace[4].points[0]).toMatchObject({ jump: 10, off: 0 });
  });

  it("catches a box that leaves the path at the pointer's speed", () => {
    const drifting = drag.slice(0, -1).map((f, i) => (i > 1 ? frame(f.t, true, 10, f.t - 10) : f));
    expect(scoreTeleport("move", drifting)).toMatchObject({ kind: "off", pass: false });
  });

  it("holds the box at the release point, not anywhere the drag passed", () => {
    // 0.4 px steps keep every frame under the jump limit; after release the box creeps back along the path.
    const held = steps(25, 0.4).map((x) => frame(x, true));
    const back = steps(25, 0.4).map((d) => frame(10, false, 10 - d));
    const r = scoreTeleport("move", [frame(0, false), frame(0, true), ...held, ...back]);
    expect(r).toMatchObject({ kind: "off", pass: false });
  });

  it("holds the element still during a crop while the outline follows", () => {
    const outline = (x) => [
      [0, 0],
      [x + 100, 0],
      [x + 100, 100],
      [0, 100],
    ];
    const crop = (x, down, shift = 0) => ({
      ...frame(0, down, shift),
      pointer: [x + 100, 50],
      outline: outline(x),
    });
    const frames = [crop(0, false), crop(0, true), crop(10, true), crop(20, true), crop(20, false)];
    expect(scoreTeleport("crop", frames).pass).toBe(true);
    expect(
      scoreTeleport(
        "crop",
        frames.map((f, i) => (i === 3 ? crop(20, true, 5) : f)),
      ).max,
    ).toBe(5);
  });

  it("fails a drag whose frames could not be measured", () => {
    const teleport = scoreTeleport("move", [{ t: 0, pointer: null, down: true }]);
    const r = {
      tracking: { max: 0 },
      pressJump: 0,
      teleport,
      drop: 0,
      reload: 0,
      render: 0,
      undo: { bytes: true, redoBytes: true, box: 0, redoBox: 0 },
      undoTimeout: null,
      smooth: { intervals: [16], work: [2], control: { intervals: [16], work: [2] } },
      unsettled: [],
    };
    expect(score({}, r).checks.teleport).toBe(false);
    // baseline.json holds the verdict under `teleport` and the number apart, so the key never means a size.
    expect(entry(score({ id: "move-x" }, r))).toMatchObject({ teleport: false, teleportPx: null });
  });
});
