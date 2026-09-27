// @vitest-environment happy-dom
// Imports the composition stack and its breadcrumb the way a host app does: by package name.
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompositionBreadcrumb, useCompositionStack, usePlayerStore } from "@hyperframes/studio";
import { cleanupMounted, mountHost } from "./components/ui/mountHost.testHelpers";

afterEach(() => {
  cleanupMounted();
  usePlayerStore.getState().reset();
});

describe("composition stack package exports", () => {
  it("lets a host hold the drill-down stack", () => {
    let labels: string[] = [];
    function Host() {
      labels = useCompositionStack({ projectId: "p" }).compositionStack.map((l) => l.label);
      return null;
    }
    mountHost(<Host />);
    expect(labels).toEqual(["Master"]);
  });

  it("keeps a loaded film's timeline when a host mounts the stack late", async () => {
    usePlayerStore
      .getState()
      .setElements([{ id: "a", tag: "div", start: 0, duration: 1, track: 0 }]);
    const onCompositionChange = vi.fn();
    function Host() {
      useCompositionStack({ projectId: "p", onCompositionChange });
      return null;
    }
    mountHost(<Host />);
    await Promise.resolve();
    expect(usePlayerStore.getState().elements).toHaveLength(1);
    expect(onCompositionChange).not.toHaveBeenCalled();
  });

  it("paints the breadcrumb with theme tokens a host can re-point", () => {
    const stack = [
      { id: "master", label: "Master", previewUrl: "/preview" },
      { id: "compositions/intro.html", label: "intro", previewUrl: "/preview/comp/intro" },
    ];
    const el = mountHost(<CompositionBreadcrumb stack={stack} onNavigate={() => {}} />);
    const classes = [...el.querySelectorAll("[class]")].map((node) => node.getAttribute("class"));
    expect(classes.join(" ")).not.toMatch(/neutral-|text-white/);
    expect(el.querySelector("nav")?.className).toContain("bg-surface/50");
    // text-text-3 keeps the parent link readable (4.5:1) on a light host theme.
    const parentLink = [...el.querySelectorAll("button")].find((b) => b.textContent === "Master");
    expect(parentLink?.className).toContain("text-text-3");
  });
});
