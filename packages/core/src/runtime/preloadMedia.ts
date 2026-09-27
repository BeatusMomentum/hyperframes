type PreloadableMedia = Pick<
  HTMLMediaElement,
  "tagName" | "preload" | "readyState" | "networkState" | "load"
>;

// Media whose preview copy is being made: it keeps its file but fetches no more than its
// metadata, so eight clips waiting for copies do not hold the browser's six connections.
const heldMedia = new WeakSet<object>();
const HOLD_PRELOAD = "metadata";

export function holdMediaLoad(media: PreloadableMedia): void {
  heldMedia.add(media);
  if (media.preload === HOLD_PRELOAD) return;
  media.preload = HOLD_PRELOAD;
  media.load();
}

export function releaseMediaLoad(media: PreloadableMedia): void {
  heldMedia.delete(media);
}

export function promotePreload(media: PreloadableMedia): void {
  if (!heldMedia.has(media) && media.preload !== "auto") media.preload = "auto";
}

export function preloadMedia(media: PreloadableMedia): void {
  if (heldMedia.has(media)) return;
  promotePreload(media);
  // load() resets an in-flight video fetch, discarding its selected resource and buffered data.
  const videoAlreadyLoading = media.tagName === "VIDEO" && media.networkState === 2;
  if (media.readyState < 3 && !videoAlreadyLoading) media.load();
}
