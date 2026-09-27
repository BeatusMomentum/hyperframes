// @vitest-environment happy-dom

import { act, createRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BlockGrid, gridColumns, gridRowKey, withFocusedRow } from "./BlockGrid";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("gridColumns", () => {
  it("fits 120px cards with 6px gaps, and never fewer than one column", () => {
    expect(gridColumns(360)).toEqual({ columns: 2, cardWidth: 177 });
    expect(gridColumns(378)).toEqual({ columns: 3, cardWidth: 122 });
    expect(gridColumns(50).columns).toBe(1);
  });
});

describe("withFocusedRow", () => {
  it("keeps the focused row and its neighbours mounted, in range or not", () => {
    expect(withFocusedRow([5, 6, 7], 1, 100)).toEqual([0, 1, 2, 5, 6, 7]);
    expect(withFocusedRow([5, 6, 7], 7, 100)).toEqual([5, 6, 7, 8]);
    expect(withFocusedRow([0, 1], 0, 2)).toEqual([0, 1]);
    expect(withFocusedRow([5, 6, 7], null, 100)).toEqual([5, 6, 7]);
    expect(withFocusedRow([0, 1], 9, 4)).toEqual([0, 1]);
  });
});

describe("gridRowKey", () => {
  it("changes with the column count and card width, so cached row heights are not reused", () => {
    expect(gridRowKey(2, 177, 3)).not.toBe(gridRowKey(4, 137.5, 3));
    expect(gridRowKey(2, 177, 3)).not.toBe(gridRowKey(2, 190, 3));
    expect(gridRowKey(2, 177.2, 3)).toBe(gridRowKey(2, 176.9, 3));
  });
});

describe("BlockGrid layout", () => {
  let root: Root | null = null;
  const saved = new Map<string, PropertyDescriptor | undefined>();
  let observers: Array<{ callback: (entries: unknown[]) => void; targets: Element[] }> = [];

  beforeEach(() => {
    // The virtualizer sizes its viewport from the scroller's box, which happy-dom reports as 0.
    for (const [prop, value] of [
      ["offsetWidth", 400],
      ["offsetHeight", 600],
    ] as const) {
      Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get: () => value });
    }
    observers = [];
    (globalThis as { ResizeObserver: unknown }).ResizeObserver = class {
      private readonly entry: { callback: (entries: unknown[]) => void; targets: Element[] };
      constructor(callback: (entries: unknown[]) => void) {
        this.entry = { callback, targets: [] };
        observers.push(this.entry);
      }
      observe(target: Element) {
        this.entry.targets.push(target);
      }
      unobserve() {}
      disconnect() {}
    };
  });

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = null;
    document.body.innerHTML = "";
    for (const [prop, descriptor] of saved) {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, prop, descriptor);
    }
  });

  const blocks = Array.from({ length: 80 }, (_, i) => ({ name: `b${i}`, title: `B${i}` }));
  const cardButton = (block: { name: string }) => (
    <button key={block.name} type="button" data-card={block.name} />
  );

  function renderGrid(
    renderCard: (block: { name: string }) => ReactNode = cardButton,
  ): HTMLElement {
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() =>
      root?.render(
        <BlockGrid
          scrollRef={createRef<HTMLDivElement>()}
          blocks={blocks as never}
          notice={<p>notice</p>}
          renderCard={renderCard as never}
        />,
      ),
    );
    return host;
  }

  function resize(host: HTMLElement, width: number, top: number) {
    const grid = host.querySelector<HTMLElement>(".overflow-y-auto > div.relative");
    if (!grid) throw new Error("no grid");
    Object.defineProperty(grid, "clientWidth", { configurable: true, value: width });
    Object.defineProperty(grid, "offsetTop", { configurable: true, value: top });
    act(() => observers.filter((o) => o.targets.includes(grid)).forEach((o) => o.callback([])));
  }

  const firstRow = (host: HTMLElement) => host.querySelector<HTMLElement>("[data-index='0']");

  it("lays rows out at the grid's width, starting at the grid's top below the notice", () => {
    const host = renderGrid();
    resize(host, 360, 40);
    expect(firstRow(host)?.style.gridTemplateColumns).toBe("repeat(2, minmax(0, 1fr))");
    expect(firstRow(host)?.style.transform).toBe("translateY(0px)");
    expect(firstRow(host)?.querySelectorAll("[data-card]")).toHaveLength(2);
  });

  it("keeps its layout while the panel is hidden and measures zero wide", () => {
    const host = renderGrid();
    resize(host, 360, 40);
    resize(host, 0, 0);
    expect(firstRow(host)?.style.gridTemplateColumns).toBe("repeat(2, minmax(0, 1fr))");
  });

  it("has the next card mounted for every Tab, past the first mounted window", () => {
    const host = renderGrid();
    resize(host, 360, 0);
    let current = host.querySelector<HTMLButtonElement>("[data-card='b0']");
    act(() => current?.focus());
    for (let step = 0; step < 40; step += 1) {
      const cards = [...host.querySelectorAll<HTMLButtonElement>("[data-card]")];
      const next = cards[cards.indexOf(current as HTMLButtonElement) + 1];
      if (!next) break;
      act(() => next.focus());
      current = next;
    }
    expect(current?.dataset.card).toBe("b40");
  });

  it("re-renders no mounted card when only the grid's own state changes", () => {
    const renderCard = vi.fn(cardButton);
    const host = renderGrid(renderCard);
    resize(host, 360, 0);
    const calls = renderCard.mock.calls.length;
    act(() => host.querySelector<HTMLButtonElement>("[data-card='b0']")?.focus());
    expect(renderCard.mock.calls.length).toBe(calls);
  });
});
