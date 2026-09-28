import { useState, useCallback, useRef } from "react";
import { useMountEffect } from "./useMountEffect";
import type { AppToast, ToastAction } from "../utils/studioHelpers";

interface ToastItem extends AppToast {
  id: number;
  /** True while the exit animation plays, just before removal. */
  leaving?: boolean;
}

const AUTO_DISMISS_MS = 4000;
const EXIT_MS = 160;
const MAX_TOASTS = 3;

let nextToastId = 1;

/**
 * Stacked toasts (max 3). Info toasts auto-dismiss after 4s; error toasts and toasts
 * with an action persist until dismissed so failures and offers can't silently vanish.
 */
export function useToast(projectId?: string | null) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [offersFor, setOffersFor] = useState(projectId);
  if (offersFor !== projectId) {
    setOffersFor(projectId);
    setToasts((prev) => prev.filter((toast) => !toast.action));
  }
  const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const clearTimer = useCallback((id: number) => {
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
  }, []);

  const removeToast = useCallback(
    (id: number) => {
      clearTimer(id);
      setToasts((prev) => prev.filter((t) => t.id !== id));
    },
    [clearTimer],
  );

  const dismissToast = useCallback(
    (id: number) => {
      clearTimer(id);
      // Mark leaving so the exit animation plays, then remove.
      setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
      const timer = setTimeout(() => removeToast(id), EXIT_MS);
      timersRef.current.set(id, timer);
    },
    [clearTimer, removeToast],
  );

  const showToast = useCallback(
    (message: string, tone: AppToast["tone"] = "error", action?: ToastAction): number => {
      const id = nextToastId++;
      setToasts((prev) => {
        const repeats = (toast: ToastItem) => action && toast.action && toast.message === message;
        const withoutRepeat = prev.filter((toast) => !repeats(toast));
        const next = [...withoutRepeat, { id, message, tone, action }];
        // Cap the stack; drop the oldest (and its pending timer).
        while (next.length > MAX_TOASTS) {
          const dropped = next.shift();
          if (dropped) clearTimer(dropped.id);
        }
        return next;
      });
      if (tone !== "error" && !action) {
        const timer = setTimeout(() => dismissToast(id), AUTO_DISMISS_MS);
        timersRef.current.set(id, timer);
      }
      return id;
    },
    [clearTimer, dismissToast],
  );

  useMountEffect(() => () => {
    for (const timer of timersRef.current.values()) clearTimeout(timer);
    timersRef.current.clear();
  });

  return { toasts, showToast, dismissToast };
}
