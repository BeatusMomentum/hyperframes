import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { hoistStyleImports, takeStyleImports } from "./styleImports";

function takenMedia(styleMedia: string, importRule: string): string[] {
  const { document } = parseHTML(
    `<html><head><style media="${styleMedia}">${importRule}</style></head></html>`,
  );
  return takeStyleImports(document.querySelector("style")!).map(
    ({ layerSupports, media }) => layerSupports + media,
  );
}

describe("takeStyleImports media intersection", () => {
  it.each([
    ["all", `@import url(x.css) print;`, "print"],
    ["print", `@import "x.css";`, "print"],
    ["print", `@import url(x.css) screen;`, "not all"],
    ["print, (min-width: 9px)", `@import url(x.css) print;`, "print, print and (min-width: 9px)"],
    ["screen", `@import url(x.css) (a) or (b);`, "screen and ((a) or (b))"],
    [
      "(a)",
      `@import url(x.css) only screen and (b), print;`,
      "screen and (a) and (b), print and (a)",
    ],
    ["not print", `@import url(x.css) (a);`, "not all"],
    [
      "print",
      `@import url(x.css) layer(base) supports(display: grid) (a);`,
      "layer(base) supports(display: grid) print and (a)",
    ],
  ])("under media %j, %s applies under %j", (media, rule, expected) => {
    expect(takenMedia(media, rule)).toEqual([expected]);
  });
});

describe("hoistStyleImports", () => {
  it("hoists a run led by a scene part into a holder with the run's media and title", () => {
    const { document } = parseHTML(
      `<html><head><style data-hf-scene="a" media="print" title="t">@import url(a.css); .a {}</style>` +
        `<style media="print" title="t">@import url(b.css);</style></head></html>`,
    );
    hoistStyleImports([...document.querySelectorAll("style")]);
    expect(
      [...document.querySelectorAll("style")].map((el) => [
        el.getAttribute("media"),
        el.getAttribute("title"),
        el.textContent,
      ]),
    ).toEqual([
      ["print", "t", "@import url(a.css);\n\n@import url(b.css);"],
      ["print", "t", ".a {}"],
      ["print", "t", ""],
    ]);
  });
});
