// @vitest-environment happy-dom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BlocksTab } from "./BlocksTab";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../../hooks/useBlockCatalog", () => ({
  useBlockCatalog: () => {
    const [search, setSearch] = useState("");
    const [category, setCategory] = useState<string | null>(null);
    return {
      loading: false,
      error: null,
      search,
      setSearch,
      category,
      setCategory,
      filteredBlocks: [],
    };
  },
}));

let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

function renderTab(): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root?.render(<BlocksTab />));
  return host;
}

function scrolledGrid(host: HTMLElement): HTMLElement {
  const grid = host.querySelector<HTMLElement>(".overflow-y-auto.min-h-0");
  if (!grid) throw new Error("no grid scroller");
  grid.scrollTop = 500;
  return grid;
}

describe("BlocksTab filtering", () => {
  it("shows a new search's results from the top", () => {
    const host = renderTab();
    const grid = scrolledGrid(host);
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Search blocks"]');
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        input,
        "fade",
      );
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(input?.value).toBe("fade");
    expect(grid.scrollTop).toBe(0);
  });

  it("shows a new category's results from the top", () => {
    const host = renderTab();
    const grid = scrolledGrid(host);
    const pill = [...host.querySelectorAll("button")].find((b) => b.textContent === "All");
    act(() => pill?.click());
    expect(grid.scrollTop).toBe(0);
  });
});
