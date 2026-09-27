import { describe, expect, it } from "vitest";
import type { TimelineElement } from "../store/playerStore";
import { timelineElementsChanged } from "./timelinePlayerSync";

const clip = (src: string): TimelineElement => ({
  id: "v1",
  tag: "video",
  start: 0,
  duration: 30,
  track: 1,
  src,
});

describe("timelineElementsChanged", () => {
  it("sees a clip re-pointed at its preview copy, so the filmstrip follows", () => {
    const original = clip("http://127.0.0.1/assets/clip1.mp4");
    const copy = clip("http://127.0.0.1/assets/clip1.mp4?hf-proxy=h264");
    expect(timelineElementsChanged([original], [copy])).toBe(true);
    expect(timelineElementsChanged([copy], [{ ...copy }])).toBe(false);
  });
});
