/** Asks for one byte of a `?hf-proxy=` URL while the server answers 202 (copy being made)
 * or 503 (queue full), after each Retry-After: a media element or decoder never sees them. */
export async function waitForServedProxy(
  href: string,
  live: () => boolean,
): Promise<{ served: boolean; waited: boolean }> {
  let waited = false;
  while (live()) {
    const res = await fetch(href, { headers: { Range: "bytes=0-0" }, cache: "no-store" }).catch(
      () => null,
    );
    void res?.body?.cancel().catch(() => {});
    if (res?.status !== 202 && res?.status !== 503) return { served: res?.ok ?? false, waited };
    waited = true;
    const seconds = Math.min(Number(res.headers.get("Retry-After")) || 2, 30);
    await new Promise((resolveWait) => setTimeout(resolveWait, seconds * 1000));
  }
  return { served: false, waited };
}

/** Whether `src` can be read now: at once for a plain URL, once the copy is served for a proxy URL. */
export async function proxiedSourceReady(src: string, live: () => boolean): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(src, window.location.href);
  } catch {
    return true;
  }
  return !url.searchParams.has("hf-proxy") || (await waitForServedProxy(src, live)).served;
}
