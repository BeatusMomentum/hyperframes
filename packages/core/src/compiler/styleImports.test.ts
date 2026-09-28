import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { hoistStyleImports } from "./styleImports";

function hoisted(styleMedia: string, importRule: string): string {
  const { document } = parseHTML(
    `<html><head><style>.a {}</style><style media="${styleMedia}">${importRule}</style></head></html>`,
  );
  hoistStyleImports([...document.querySelectorAll("style")]);
  return document.querySelector("style")!.textContent!.split("\n\n")[0]!;
}

describe("hoistStyleImports media intersection", () => {
  it.each([
    ["all", `@import url(x.css) print;`, `@import url(x.css) print;`],
    ["print", `@import "x.css";`, `@import "x.css" print;`],
    ["print", `@import url(x.css) screen;`, `@import url(x.css) not all;`],
    [
      "print, (min-width: 9px)",
      `@import url(x.css) print;`,
      `@import url(x.css) print, print and (min-width: 9px);`,
    ],
    ["screen", `@import url(x.css) (a) or (b);`, `@import url(x.css) screen and ((a) or (b));`],
    [
      "(a)",
      `@import url(x.css) only screen and (b), print;`,
      `@import url(x.css) screen and (a) and (b), print and (a);`,
    ],
    ["not print", `@import url(x.css) (a);`, `@import url(x.css) not all;`],
    [
      "print",
      `@import url(x.css) layer(base) supports(display: grid) (a);`,
      `@import url(x.css) layer(base) supports(display: grid) print and (a);`,
    ],
  ])("under media %j, %s lifts as %s", (media, rule, expected) => {
    expect(hoisted(media, rule)).toBe(expected);
  });
});
