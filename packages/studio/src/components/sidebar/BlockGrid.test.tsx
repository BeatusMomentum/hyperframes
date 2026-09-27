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

const originalResizeObserver = globalThis.ResizeObserver;

describe("BlockGrid layout", () => {
  let root: Root | null = null;
  const savedProps = new Map<string, PropertyDescriptor | undefined>();
  let savedResizeObserver: unknown;
  let observers: Array<{ callback: (entries: unknown[]) => void; targets: Element[] }> = [];

  beforeEach(() => {
    // happy-dom lays nothing out: the scroller is 400x600, and a row measures by its column count,
    // 150px tall at 2 columns and 110px at 4.
    const rowHeight = (el: HTMLElement) => {
      const columns = /repeat\((\d+),/.exec(el.style?.gridTemplateColumns ?? "")?.[1];
      if (!el.dataset?.index || !columns) return undefined;
      return columns === "2" ? 150 : 110;
    };
    for (const [prop, value] of [
      ["offsetWidth", () => 400],
      ["offsetHeight", (el: HTMLElement) => rowHeight(el) ?? 600],
    ] as const) {
      savedProps.set(prop, Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop));
      Object.defineProperty(HTMLElement.prototype, prop, {
        configurable: true,
        get(this: HTMLElement) {
          return value(this);
        },
      });
    }
    savedResizeObserver = globalThis.ResizeObserver;
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
    for (const [prop, descriptor] of savedProps) {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, prop, descriptor);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[prop];
    }
    savedProps.clear();
    (globalThis as { ResizeObserver: unknown }).ResizeObserver = savedResizeObserver;
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

  it("measures rows afresh when a resize changes the column count", () => {
    const host = renderGrid();
    resize(host, 360, 0);
    const secondRow = () => host.querySelector<HTMLElement>("[data-index='1']");
    expect(secondRow()?.style.transform).toBe("translateY(150px)");
    resize(host, 520, 0);
    expect(firstRow(host)?.style.gridTemplateColumns).toBe("repeat(4, minmax(0, 1fr))");
    // A height cached at 2 columns would leave the second row at 150px.
    expect(secondRow()?.style.transform).toBe("translateY(110px)");
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

describe("after the layout tests", () => {
  it("has the layout stubs restored", () => {
    const div = document.createElement("div");
    div.dataset.index = "0";
    div.style.gridTemplateColumns = "repeat(2, minmax(0, 1fr))";
    expect(div.offsetHeight).toBe(0);
    expect(div.offsetWidth).toBe(0);
    expect(globalThis.ResizeObserver).toBe(originalResizeObserver);
  });
});
