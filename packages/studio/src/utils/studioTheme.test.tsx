// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import path from "node:path";
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { ThemeToggle } from "../components/ThemeToggle";
import { cleanupMounted, mountHost } from "../components/ui/mountHost.testHelpers";
import { shownStudioTheme } from "./studioTheme";

const KEY = "hf-studio-ui-preferences";
const html = readFileSync(path.join(__dirname, "../../index.html"), "utf8");
const boot = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";

function store(theme: unknown) {
  localStorage.setItem(KEY, JSON.stringify({ theme }));
}

afterEach(() => {
  cleanupMounted();
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});

describe("Studio's theme", () => {
  it.each([["light"], ["dark"], [undefined], ["neon"]])(
    "boots to the theme the owner shows (saved %s)",
    (saved) => {
      store(saved);
      new Function(boot)();
      expect(document.documentElement.dataset.theme === "paper").toBe(
        shownStudioTheme() === "light",
      );
    },
  );

  it("opens light the first time", () => {
    new Function(boot)();
    expect(document.documentElement.dataset.theme).toBe("paper");
    expect(shownStudioTheme()).toBe("light");
  });

  it("runs the boot script before the app's module", () => {
    expect(boot).toContain(`"${KEY}"`);
    expect(html.indexOf("<script>")).toBeLessThan(html.indexOf('type="module"'));
  });

  it("flips the document between light and dark and keeps the choice", () => {
    store("dark");
    const host = mountHost(<ThemeToggle />);
    const button = () => host.querySelector("button")!;
    expect(button().getAttribute("aria-label")).toBe("Switch to light theme");

    act(() => button().click());
    expect(document.documentElement.dataset.theme).toBe("paper");
    expect(JSON.parse(localStorage.getItem(KEY)!).theme).toBe("light");
    expect(button().getAttribute("aria-label")).toBe("Switch to dark theme");

    act(() => button().click());
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(JSON.parse(localStorage.getItem(KEY)!).theme).toBe("dark");
  });
});
