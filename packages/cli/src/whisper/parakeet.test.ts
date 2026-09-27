import { describe, expect, it } from "vitest";
import {
  hasDroppedSpeech,
  mergeTokensToWords,
  mergeWindowsToWords,
  silenceCuts,
} from "./parakeet.js";

describe("mergeTokensToWords", () => {
  it("joins Parakeet sub-word tokens into words on the space boundary", () => {
    const words = mergeTokensToWords({
      text: "Hello everyone. Um,",
      sentences: [
        {
          tokens: [
            { text: " H", start: 0.0, end: 0.24 },
            { text: "ello", start: 0.24, end: 0.48 },
            { text: " everyone.", start: 0.48, end: 1.28 },
            { text: " Um,", start: 1.28, end: 1.92 },
          ],
        },
      ],
    });
    expect(words).toEqual([
      { text: "Hello", start: 0.0, end: 0.48 },
      { text: "everyone.", start: 0.48, end: 1.28 },
      { text: "Um,", start: 1.28, end: 1.92 },
    ]);
  });

  it("spans sentences and tolerates missing tokens", () => {
    expect(mergeTokensToWords({}).length).toBe(0);
    const words = mergeTokensToWords({
      sentences: [
        { tokens: [{ text: "Hi", start: 0, end: 0.2 }] },
        { tokens: [{ text: " there", start: 0.5, end: 0.9 }] },
      ],
    });
    expect(words.map((w) => w.text)).toEqual(["Hi", "there"]);
    expect(words[1]!.start).toBe(0.5);
  });
});

describe("mergeWindowsToWords", () => {
  it("shifts each window's token times by the window's start", () => {
    const words = mergeWindowsToWords([
      { offset: 0, tokens: [" Hel", "lo"], timestamps: [0.125, 0.25], durations: [0.125, 0.25] },
      { offset: 60.5, tokens: [" world"], timestamps: [0.25], durations: [0.5] },
    ]);
    expect(words).toEqual([
      { text: "Hello", start: 0.125, end: 0.5 },
      { text: "world", start: 60.75, end: 61.25 },
    ]);
  });
});

describe("silenceCuts", () => {
  // 100 samples/s keeps the fixture small: 150 s of steady sound with two 0.1 s silences.
  const rate = 100;
  const loud = (seconds: number) => new Float32Array(seconds * rate).fill(0.5);

  it("moves each cut to the quietest 100 ms within 5 s of the 60 s target", () => {
    const samples = loud(150);
    samples.fill(0, 5830, 5840);
    samples.fill(0, 12195, 12205);
    expect(silenceCuts(samples, rate)).toEqual([0, 5835, 12200, 15000]);
  });

  it("leaves audio shorter than one window whole", () => {
    expect(silenceCuts(loud(42), rate)).toEqual([0, 4200]);
  });

  it("makes no window for empty audio", () => {
    expect(silenceCuts(new Float32Array(0), rate)).toEqual([0]);
  });
});

describe("hasDroppedSpeech", () => {
  const rate = 100;
  const tokens = (timestamps: number[]) => ({
    tokens: timestamps.map(() => " w"),
    timestamps,
    durations: timestamps.map(() => 0.2),
  });

  it("flags a second of loud audio before the first token", () => {
    const speech = new Float32Array(6 * rate).fill(0.5);
    expect(hasDroppedSpeech(speech, rate, tokens([2.08, 2.5, 3, 3.5, 4, 4.5, 5, 5.5]))).toBe(true);
    expect(
      hasDroppedSpeech(speech, rate, tokens([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5])),
    ).toBe(false);
  });

  it("ignores a quiet pause and silence with no tokens", () => {
    const pause = new Float32Array(6 * rate).fill(0.5);
    pause.fill(0, 2 * rate, 4 * rate);
    expect(hasDroppedSpeech(pause, rate, tokens([0.1, 0.6, 1.1, 1.6, 4.1, 4.6, 5.1, 5.6]))).toBe(
      false,
    );
    expect(hasDroppedSpeech(new Float32Array(3 * rate), rate, tokens([]))).toBe(false);
  });
});
