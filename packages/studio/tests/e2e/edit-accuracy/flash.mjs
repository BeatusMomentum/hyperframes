/** Preview flashes: every frame the screencast paints, from an action to its settle, against the frames around it. */

// A 4x4 marker in the top-left corner, outside every region, repaints every rAF with the frame counter in its
// colour, so the screencast (which only sends repainted frames) sends every frame and each one is numbered.
function markerOn() {
  const bench = window.__editBench;
  if (bench.marker) return;
  const el = Object.assign(document.createElement("div"), { id: "edit-bench-marker" });
  el.style.cssText =
    "position:fixed;left:0;top:0;width:4px;height:4px;z-index:2147483647;pointer-events:none";
  document.documentElement.append(el);
  bench.marker = { el, n: 0, on: true, masks: [] };
  const tick = () => {
    if (!bench.marker?.on) return;
    const n = ++bench.marker.n;
    el.style.background = `rgb(${n & 255},${(n >> 8) & 255},128)`;
    // Toasts slide in and out by design; wherever one was during the window is left out of the comparison.
    for (const t of document.querySelectorAll(".hf-toast-enter, .hf-toast-exit")) {
      const r = t.getBoundingClientRect();
      bench.marker.masks.push([r.left, r.top, r.right, r.bottom].map(Math.round));
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function markerOff() {
  const m = window.__editBench.marker;
  if (!m) return;
  m.on = false;
  m.el.remove();
  window.__editBench.marker = null;
}

/** The panes a flash can show in, as screen rects: preview (with its chrome), timeline and inspector. */
function paneRects() {
  const part = (el) => el?.closest(".dv-react-part");
  const rect = (el) => {
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.x),
      y: Math.round(r.y),
      w: Math.round(r.width),
      h: Math.round(r.height),
    };
  };
  const preview = part(document.querySelector('[data-testid="preview-zoom-stage"]'));
  const parts = [...document.querySelectorAll(".dv-react-part")].filter((e) => e.offsetWidth > 0);
  const p = preview && rect(preview);
  const timeline =
    part(document.querySelector('[data-testid="timeline-clip"]')) ??
    parts.reduce((a, b) => (!a || rect(b).y > rect(a).y ? b : a), null);
  const area = (e) => rect(e).w * rect(e).h;
  const inspector =
    p &&
    parts
      .filter((e) => rect(e).x >= p.x + p.w - 1 && rect(e).y < p.y + p.h)
      .reduce((a, b) => (!a || area(b) > area(a) ? b : a), null);
  return Object.fromEntries(
    Object.entries({ preview, timeline, inspector })
      .filter(([, e]) => e)
      .map(([k, e]) => [k, rect(e)]),
  );
}

/** Starts a screencast of one action window; stop() returns its PNG frames and the marker range it spans. */
export async function startCapture(page, { marker = true } = {}) {
  const cdp = await page.createCDPSession();
  const frames = [];
  cdp.on("Page.screencastFrame", (f) => {
    frames.push(f.data);
    cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => undefined);
  });
  if (marker) await page.evaluate(markerOn);
  const counter = () => page.evaluate(() => window.__editBench.marker?.n ?? null);
  const masks = () => page.evaluate(() => window.__editBench.marker?.masks ?? []);
  await cdp.send("Page.startScreencast", { format: "png", everyNthFrame: 1 });
  // The first frame is the state before the action.
  for (const deadline = Date.now() + 2000; !frames.length && Date.now() < deadline; )
    await new Promise((r) => setTimeout(r, 10));
  const from = await counter();
  return {
    async stop() {
      const [to, mask] = [await counter(), await masks()];
      await cdp.send("Page.stopScreencast").catch(() => undefined);
      if (marker) await page.evaluate(markerOff).catch(() => undefined);
      await cdp.detach().catch(() => undefined);
      return { frames, from, to, masks: mask };
    },
  };
}

export const panes = (page) => page.evaluate(paneRects);

/**
 * In the decoder page: per frame, the marker counter and the pixels that differ from the before frame and from the
 * after frame in each pane. A pixel differs when any channel moves more than `colourTol`.
 */
function compareFrames(frames, before, after, regions, masks, colourTol) {
  // fallow-ignore-next-line complexity
  return (async () => {
    const decode = async (b64) => {
      const bmp = await createImageBitmap(
        await (await fetch(`data:image/png;base64,${b64}`)).blob(),
      );
      const g = new OffscreenCanvas(bmp.width, bmp.height).getContext("2d", {
        willReadFrequently: true,
      });
      g.drawImage(bmp, 0, 0);
      return g.getImageData(0, 0, bmp.width, bmp.height);
    };
    const masked = (x, y) => masks.some(([l, t, r, b]) => x >= l && x < r && y >= t && y < b);
    // fallow-ignore-next-line complexity
    const differing = (a, b, r) => {
      let n = 0;
      for (let y = r.y; y < r.y + r.h; y++)
        for (let x = r.x; x < r.x + r.w; x++) {
          if (masks.length && masked(x, y)) continue;
          const i = (y * a.width + x) * 4;
          if (
            Math.abs(a.data[i] - b.data[i]) > colourTol ||
            Math.abs(a.data[i + 1] - b.data[i + 1]) > colourTol ||
            Math.abs(a.data[i + 2] - b.data[i + 2]) > colourTol
          )
            n++;
        }
      return n;
    };
    const [b, a] = [await decode(before), await decode(after)];
    const out = [];
    for (const f of frames) {
      const img = await decode(f);
      const counter = img.data[4 * (img.width + 1)] + 256 * img.data[4 * (img.width + 1) + 1];
      const diffs = Object.fromEntries(
        Object.entries(regions).map(([k, r]) => [k, [differing(img, b, r), differing(img, a, r)]]),
      );
      out.push({ counter, diffs });
    }
    return out;
  })();
}

/**
 * A frame is bad when some pane differs from the before frame and from the after frame by more pixels than a
 * 0.5 px shift of the element's perimeter moves. Coverage is marker counters seen over counters in the window.
 */
// fallow-ignore-next-line complexity
async function scoreWindow(
  decoder,
  { frames, from, to, before, after, masks = [] },
  regions,
  tolPx,
) {
  const b = before ?? frames[0];
  const a = after ?? frames.at(-1);
  if (!b || !a) return { frames: 0, coverage: 0, bad: [], longest: 0 };
  const rows = await decoder.evaluate(
    compareFrames,
    frames,
    b,
    a,
    regions,
    dedupe(masks),
    COLOUR_TOL,
  );
  const seen = new Set(rows.map((r) => r.counter).filter((c) => c >= from && c <= to));
  const span = from === null || to === null ? null : to - from + 1;
  const bad = [];
  rows.forEach((r, i) => {
    const panes = Object.entries(r.diffs)
      .filter(([, [vsBefore, vsAfter]]) => vsBefore > tolPx && vsAfter > tolPx)
      .map(([k, [vsBefore, vsAfter]]) => ({ pane: k, vsBefore, vsAfter }));
    if (panes.length) bad.push({ frame: i, counter: r.counter, panes });
  });
  let [longest, run] = [0, 0];
  rows.forEach((_, i) => {
    run = bad.some((x) => x.frame === i) ? run + 1 : 0;
    longest = Math.max(longest, run);
  });
  return {
    frames: frames.length,
    rafFrames: span,
    coverage: span ? seen.size / span : null,
    bad,
    longest,
  };
}

const dedupe = (rects) =>
  [...new Set(rects.map((r) => r.join(",")))].map((k) => k.split(",").map(Number));

// PNG is lossless; this absorbs only anti-aliasing and subpixel text noise between otherwise equal frames.
const COLOUR_TOL = 24;
const MIN_COVERAGE = 0.9;

/** Scores every window of a case; the offending frames go to `evidence.flashFrames` as PNG. */
export async function scoreFlash(decoder, { regions, tolPx, windows }, evidence) {
  const out = {};
  evidence.flashFrames = [];
  for (const [name, win] of Object.entries(windows)) {
    const scored = await scoreWindow(decoder, win, regions, tolPx);
    for (const b of scored.bad)
      evidence.flashFrames.push([
        `${name}-${b.frame}-${b.panes.map((p) => p.pane).join("+")}`,
        win.frames[b.frame],
      ]);
    out[name] = scored;
  }
  const all = Object.values(out);
  const coverage = Math.min(...all.map((w) => w.coverage ?? 0));
  return {
    bad: all.reduce((n, w) => n + w.bad.length, 0),
    longest: Math.max(0, ...all.map((w) => w.longest)),
    coverage,
    uncovered: !(coverage >= MIN_COVERAGE),
    regions,
    tolPx,
    windows: out,
  };
}
