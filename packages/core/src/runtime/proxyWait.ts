/** Asks for one byte of a `?hf-proxy=` URL while the server answers 202 (copy being made)
 * or 503 (queue full), after each Retry-After: a media element never sees those statuses. */
export async function waitForServedProxy(href: string, live: () => boolean): Promise<boolean> {
  while (live()) {
    const res = await fetch(href, { headers: { Range: "bytes=0-0" }, cache: "no-store" }).catch(
      () => null,
    );
    void res?.body?.cancel().catch(() => {});
    if (res?.status !== 202 && res?.status !== 503) return res?.ok ?? false;
    const seconds = Math.min(Number(res.headers.get("Retry-After")) || 2, 30);
    await new Promise((resolveWait) => setTimeout(resolveWait, seconds * 1000));
  }
  return false;
}
