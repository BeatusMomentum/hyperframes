// The one owner of Studio's own theme: the toggle's saved choice, else light. Light is
// `data-theme="paper"` on the document element, the hook theme.css keys on; dark is no attribute.
// index.html repeats this rule before the first paint; studioTheme.test.tsx holds the two together.
import { useSyncExternalStore } from "react";
import {
  readStudioUiPreferences,
  writeStudioUiPreferences,
  type StudioTheme,
} from "./studioUiPreferences";

const listeners = new Set<() => void>();

export function shownStudioTheme(): StudioTheme {
  return readStudioUiPreferences().theme ?? "light";
}

function apply(): void {
  const root = document.documentElement;
  if (shownStudioTheme() === "light") root.dataset.theme = "paper";
  else delete root.dataset.theme;
  for (const listener of listeners) listener();
}

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
