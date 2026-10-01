import type { CSSProperties } from "react";

type Rect = { left: number; top: number; width: number; height: number };

/** The selection chrome positions from these, so one style write on its wrapper moves all of it. */
const VAR = {
  left: "--hf-chrome-left",
  top: "--hf-chrome-top",
  width: "--hf-chrome-width",
  height: "--hf-chrome-height",
} as const;

export const CHROME_LEFT = `var(${VAR.left})`;
export const CHROME_TOP = `var(${VAR.top})`;
export const CHROME_WIDTH = `var(${VAR.width})`;
export const CHROME_HEIGHT = `var(${VAR.height})`;

export function chromeRectVars(rect: Rect): CSSProperties {
  return {
    [VAR.left]: `${rect.left}px`,
    [VAR.top]: `${rect.top}px`,
    [VAR.width]: `${rect.width}px`,
    [VAR.height]: `${rect.height}px`,
  } as CSSProperties;
}
