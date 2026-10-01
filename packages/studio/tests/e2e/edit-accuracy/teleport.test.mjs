import { describe, expect, it } from "vitest";
import { scoreTeleport } from "./teleport.mjs";

// The composition root drawn 1:1 at the origin, and a 100 px box whose centre the pointer holds.
const root = [
  [0, 0],
  [1920, 0],
  [1920, 1080],
  [0, 1080],
];
const box = (x) => [
  [x, 0],
  [x + 100, 0],
  [x + 100, 100],
  [x, 100],
];
const frame = (x, down, shift = 0) => ({
  t: x,
  pointer: [x + 50, 50],
  down,
  root,
  quad: box(x + shift),
  size: [100, 100],
  clip: "none",
});
const drag = [
  frame(0, false),
  frame(0, true),
  ...[1, 2, 3, 4, 5].map((i) => frame(i * 10, true)),
  frame(50, false),
  frame(50, false),
];

describe("scoreTeleport", () => {
  it("passes a box that follows the pointer every frame", () => {
    expect(scoreTeleport("move", drag)).toMatchObject({ max: 0, pass: true });
  });

  it("catches a one-frame jump mid-drag at that frame", () => {
    const jumped = drag.map((f, i) => (i === 4 ? frame(30, true, 5) : f));
    expect(scoreTeleport("move", jumped)).toMatchObject({
      max: 5,
      frame: 4,
      kind: "jump",
      pass: false,
    });
  });

  it("catches a box that snaps back after release", () => {
    const snapped = [...drag, { ...frame(50, false), quad: box(0) }];
    expect(scoreTeleport("move", snapped)).toMatchObject({ pass: false, frame: drag.length });
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
    expect(scoreTeleport("move", [{ t: 0, pointer: null, down: true }])).toMatchObject({
      max: null,
    });
  });
});
