// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { StudioToast } from "../components/StudioToast";
import { useToast } from "./useToast";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => vi.useRealTimers());

async function mount(projectId = "a") {
  let toast!: ReturnType<typeof useToast>;
  function Probe({ projectId }: { projectId: string }) {
    toast = useToast(projectId);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  const render = (id: string) =>
    act(async () => root.render(createElement(Probe, { projectId: id })));
  await render(projectId);
  return { toast: () => toast, render, root };
}

const offer = (run = () => {}) => ({ label: "Undo Agent turn", run });

it("an info toast with an action stays until it is used or dismissed", async () => {
  vi.useFakeTimers();
  const { toast: current, root } = await mount();
  const toast = current();
  act(() => {
    toast.showToast("Saved", "info");
    toast.showToast("Can't undo", "info", offer());
  });
  await act(async () => vi.advanceTimersByTime(10_000));
  expect(current().toasts.map((item) => item.message)).toEqual(["Can't undo"]);
  act(() => root.unmount());
});

it("the same offer again replaces the one showing instead of stacking", async () => {
  const { toast, root } = await mount();
  const latest = offer();
  act(() => toast().showToast("Can't undo", "info", offer()));
  act(() => toast().showToast("Can't undo", "info", latest));
  expect(toast().toasts.map((item) => item.action)).toEqual([latest]);
  act(() => root.unmount());
});

it("switching projects drops the offers and keeps other toasts", async () => {
  const { toast, render, root } = await mount("a");
  act(() => {
    toast().showToast("Disk full");
    toast().showToast("Can't undo", "info", offer());
  });
  await render("b");
  expect(toast().toasts.map((item) => item.message)).toEqual(["Disk full"]);
  act(() => root.unmount());
});

it("an offer's button does nothing once its toast is leaving", async () => {
  const run = vi.fn();
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () =>
    root.render(
      createElement(StudioToast, { message: "Can't undo", leaving: true, action: offer(run) }),
    ),
  );
  act(() => host.querySelector("button")!.click());
  expect(run).not.toHaveBeenCalled();
  act(() => root.unmount());
});
