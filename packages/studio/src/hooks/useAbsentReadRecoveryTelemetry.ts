import { useEffect, useRef } from "react";
import { trackStudioEvent } from "../utils/studioTelemetry";

/**
 * Tracks whether `useSdkSession`'s tree-refresh-on-absent fallback
 * (`onAbsentRead`) actually resolves a stale tree, and reports
 * `sdk_absent_read_recovery` telemetry for it.
 *
 * The prior acceptance metric for that fallback — absent-reads-per-tab —
 * turned out to never move with or without the fix: it was dominated by
 * agent-driven sessions where more than one absent read per tab was already
 * the norm, not a sign of the loop the fallback targets.
 *
 * This measures the one thing that metric couldn't, and does so on the
 * TREE, not on a same-path read succeeding: `onAbsentRead` only calls
 * `refreshFileTree`, which starts no read, and in the fallback's own target
 * scenario — an agent deletes the file and the SSE-driven refresh is missed
 * — no same-path read ever happens again. The tree just stops listing the
 * path, and `CompositionMissingBanner` tells the user to pick another
 * composition. Measuring "read succeeded" would have scored that as
 * unrecovered. What the fallback actually controls is the tree itself, so
 * recovery here is "this path is no longer in `fileTree`".
 *
 * Keyed by path alone, not `${projectId}:${path}` — the composite key could
 * stringify two different (projectId, path) pairs identically once either
 * part contains `:`. Safe without the prefix only because every entry is
 * cleared on `projectId` change, so just one project's worth is ever live.
 */
export function useAbsentReadRecoveryTelemetry(
  projectId: string | null,
  fileTree: readonly string[],
  fileTreeLoaded: boolean,
) {
  const refreshedPathsRef = useRef<Set<string>>(new Set());
  const pendingRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    refreshedPathsRef.current.clear();
    pendingRef.current.clear();
  }, [projectId]);

  // Runs on every tree update rather than tied to this hook's own open/read
  // cycle — on the master view, a refresh rotates `masterCompPath` to the
  // next composition, so the path `useSdkSession` is currently reading is
  // NOT the one whose absence triggered the fallback; only the tree itself
  // says whether that one resolved.
  useEffect(() => {
    if (!fileTreeLoaded || pendingRef.current.size === 0) return;
    for (const [path, startedAt] of pendingRef.current) {
      if (fileTree.includes(path)) continue;
      pendingRef.current.delete(path);
      trackStudioEvent("sdk_absent_read_recovery", {
        stage: "tree_corrected",
        elapsed_ms: performance.now() - startedAt,
      });
    }
  }, [fileTree, fileTreeLoaded]);

  /**
   * Fires the once-per-path fallback for an absent read. No-ops without a
   * collaborator: `onAbsentRead` is absent on the secondary SDK sessions
   * DesignPanelPromoteProvider opens, which default to the SAME path as the
   * primary session when nothing is selected — without this guard, one
   * absent file fires `triggered` twice, once per hook instance, with no
   * field to tell PostHog's two identical events apart.
   */
  function triggerOnce(path: string, onAbsentRead: ((path: string) => void) | undefined): void {
    if (!onAbsentRead) return;
    if (refreshedPathsRef.current.has(path)) return;
    refreshedPathsRef.current.add(path);
    pendingRef.current.set(path, performance.now());
    trackStudioEvent("sdk_absent_read_recovery", { stage: "triggered" });
    onAbsentRead(path);
  }

  return { triggerOnce };
}
