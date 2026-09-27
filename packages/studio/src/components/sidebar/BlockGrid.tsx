import { memo, useCallback, useState, type ReactNode, type RefObject } from "react";
import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual";
import type { useBlockCatalog } from "../../hooks/useBlockCatalog";

type CatalogBlock = ReturnType<typeof useBlockCatalog>["filteredBlocks"][number];

// Same geometry as the CSS grid it replaces: repeat(auto-fill, minmax(120px, 1fr)) with gap-1.5.
const CARD_MIN_W = 120;
const CARD_GAP = 6;
const CARD_TEXT_H = 38.5;
const ROW_OVERSCAN = 2;

/** Column count and card width of the auto-fill grid at a given width. */
export function gridColumns(width: number): { columns: number; cardWidth: number } {
  const columns = Math.max(1, Math.floor((width + CARD_GAP) / (CARD_MIN_W + CARD_GAP)));
  return { columns, cardWidth: (width - (columns - 1) * CARD_GAP) / columns };
}

/**
 * The rows to mount, plus the focused row and its neighbours: scrolling focus away must not drop it to <body>,
 * and Tab or Shift+Tab must find the next card already mounted, however fast it is pressed.
 */
export function withFocusedRow(rows: number[], focusedRow: number | null, count: number): number[] {
  if (focusedRow === null || focusedRow >= count) return rows;
  const pinned = [focusedRow - 1, focusedRow, focusedRow + 1].filter(
    (row) => row >= 0 && row < count,
  );
  return [...new Set([...rows, ...pinned])].sort((a, b) => a - b);
}

/** Row heights are cached by key, so a new column count or card width must not reuse the old ones. */
export function gridRowKey(columns: number, cardWidth: number, index: number): string {
  return `${columns}:${Math.round(cardWidth)}:${index}`;
}

/**
 * Renders only the rows near the viewport. Every mounted card is a paint chunk Chrome re-layerizes on
 * each frame the preview repaints, so an unvirtualized catalog taxed playback on every frame.
 */
export function BlockGrid({
  scrollRef,
  blocks,
  notice,
  renderCard,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  blocks: CatalogBlock[];
  notice: ReactNode;
  renderCard: (block: CatalogBlock) => ReactNode;
}) {
  const [gridWidth, setGridWidth] = useState(0);
  const [gridTop, setGridTop] = useState(0);
  const [focusedRow, setFocusedRow] = useState<number | null>(null);
  const measureGrid = useCallback((grid: HTMLDivElement | null) => {
    if (!grid) return;
    // The notice above the grid comes and goes with the category, moving where the rows start.
    const observer = new ResizeObserver(() => {
      // A hidden dock panel measures 0: keep the last layout so its scroll position survives.
      if (grid.clientWidth === 0) return;
      setGridWidth(grid.clientWidth);
      setGridTop(grid.offsetTop);
    });
    observer.observe(grid);
    if (grid.previousElementSibling) observer.observe(grid.previousElementSibling);
    return () => observer.disconnect();
  }, []);

  const { columns, cardWidth } = gridColumns(gridWidth);
  const rowCount = Math.ceil(blocks.length / columns);
  const rangeExtractor = useCallback(
    (range: Range) => withFocusedRow(defaultRangeExtractor(range), focusedRow, range.count),
    [focusedRow],
  );
  const getItemKey = useCallback(
    (index: number) => gridRowKey(columns, cardWidth, index),
    [columns, cardWidth],
  );
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => (cardWidth * 9) / 16 + CARD_TEXT_H + CARD_GAP,
    overscan: ROW_OVERSCAN,
    scrollMargin: gridTop,
    rangeExtractor,
    getItemKey,
  });

  return (
    <div ref={scrollRef} className="relative flex-1 overflow-y-auto min-h-0 px-2 pb-2">
      <div>{notice}</div>
      {blocks.length === 0 ? (
        <div className="flex items-center justify-center h-32 text-neutral-600 text-xs">
          No blocks match your search
        </div>
      ) : (
        <div
          ref={measureGrid}
          className="relative"
          style={{ height: gridWidth > 0 ? virtualizer.getTotalSize() : undefined }}
          onFocus={(event) => {
            const row = (event.target as HTMLElement).closest<HTMLElement>("[data-index]");
            if (row) setFocusedRow(Number(row.dataset.index));
          }}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null))
              setFocusedRow(null);
          }}
        >
          {gridWidth > 0 &&
            virtualizer
              .getVirtualItems()
              .map((row) => (
                <GridRow
                  key={row.key}
                  index={row.index}
                  top={row.start - gridTop}
                  columns={columns}
                  blocks={blocks}
                  renderCard={renderCard}
                  measureElement={virtualizer.measureElement}
                />
              ))}
        </div>
      )}
    </div>
  );
}

/** Memoised, so a scroll re-renders only the rows entering or leaving, not every visible card. */
const GridRow = memo(function GridRow({
  index,
  top,
  columns,
  blocks,
  renderCard,
  measureElement,
}: {
  index: number;
  top: number;
  columns: number;
  blocks: CatalogBlock[];
  renderCard: (block: CatalogBlock) => ReactNode;
  measureElement: (node: Element | null) => void;
}) {
  return (
    <div
      data-index={index}
      ref={measureElement}
      className="absolute inset-x-0 top-0 grid gap-1.5 pb-1.5"
      style={{
        gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
        transform: `translateY(${top}px)`,
      }}
    >
      {blocks.slice(index * columns, (index + 1) * columns).map(renderCard)}
    </div>
  );
});
