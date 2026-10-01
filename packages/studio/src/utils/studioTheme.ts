// The one owner of Studio's own theme: the toggle's saved choice, else the system's. Light is
// `data-theme="paper"` on the document element, the hook theme.css keys on; dark is no attribute.
// index.html repeats this rule before the first paint; studioTheme.test.ts holds the two together.
import { useSyncExternalStore } from "react";
import {
  readStudioUiPreferences,
  writeStudioUiPreferences,
  type StudioTheme,
} from "./studioUiPreferences";

const SYSTEM_DARK = "(prefers-color-scheme: dark)";
const listeners = new Set<() => void>();

export function shownStudioTheme(): StudioTheme {
  const systemLight = globalThis.window?.matchMedia?.(SYSTEM_DARK).matches === false;
  return readStudioUiPreferences().theme ?? (systemLight ? "light" : "dark");
}

function apply(): void {
  const root = document.documentElement;
  if (shownStudioTheme() === "light") root.dataset.theme = "paper";
  else delete root.dataset.theme;
  for (const listener of listeners) listener();
}

// With no saved choice, the system's change is the theme's change.
globalThis.window?.matchMedia?.(SYSTEM_DARK)?.addEventListener?.("change", apply);

export function setStudioTheme(theme: StudioTheme): void {
  writeStudioUiPreferences({ theme });
  apply();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const useShownStudioTheme = (): StudioTheme =>
  useSyncExternalStore(subscribe, shownStudioTheme);
