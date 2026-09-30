/**
 * Preview flashes and edit-to-paint: every frame the screencast paints, from an action to its settle, against the
 * frames around it.
 */

// A 4x4 marker in the top-left corner, outside every region, repaints every rAF with the frame counter in its
// colour, so the screencast (which only sends repainted frames) sends every frame and each one is numbered.
// It also logs the counter at each committing input (pointer-up, a non-modifier key), in any same-origin frame.
function markerOn() {
  const bench = window.__editBench;
  if (bench.marker) return;
  const el = Object.assign(document.createElement("div"), { id: "edit-bench-marker" });
  el.style.cssText =
    "position:fixed;left:0;top:0;width:4px;height:4px;z-index:2147483647;pointer-events:none";
  document.documentElement.append(el);
  const marker = { el, n: 0, on: true, masks: [], times: [], inputs: [], unlisten: [] };
  bench.marker = marker;
  const MODIFIERS = new Set(["Control", "Shift", "Alt", "Meta"]);
  const log = (e) => {
    if (e.type === "pointerup" || !MODIFIERS.has(e.key))
      marker.inputs.push({ type: e.type, key: e.key ?? null, n: marker.n, t: performance.now() });
  };
  const listen = (w) => {
    for (const type of ["pointerup", "keydown"]) {
      w.addEventListener(type, log, true);
      marker.unlisten.push(() => w.removeEventListener(type, log, true));
    }
    for (const f of w.document.querySelectorAll("iframe")) {
      try {
        listen(f.contentWindow);
      } catch {
        // A cross-origin frame cannot take an input Studio handles.
      }
    }
  };
  listen(window);
  const tick = () => {
    if (!marker.on) return;
    const n = ++marker.n;
    marker.times[n] = performance.now();
    el.style.background = `rgb(${n & 255},${(n >> 8) & 255},128)`;
    // Toasts slide in and out by design; wherever one was during the window is left out of the comparison.
    for (const t of document.querySelectorAll(".hf-toast-enter, .hf-toast-exit")) {
      const r = t.getBoundingClientRect();
      marker.masks.push([r.left, r.top, r.right, r.bottom].map(Math.round));
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function markerOff() {
  const m = window.__editBench.marker;
  if (!m) return;
  m.on = false;
  for (const off of m.unlisten) off();
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

/**
 * Starts a screencast of one action window; stop() returns its PNG frames, the marker range it spans, the rAF time
 * of each counter and the committing inputs logged in it.
 */
export async function startCapture(page, { marker = true } = {}) {
  const cdp = await page.createCDPSession();
  const frames = [];
  cdp.on("Page.screencastFrame", (f) => {
    frames.push(f.data);
    cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => undefined);
  });
  if (marker) await page.evaluate(markerOn);
  const state = () =>
    page.evaluate(() => {
      const m = window.__editBench.marker;
      return m ? { n: m.n, masks: m.masks, times: m.times, inputs: m.inputs } : { n: null };
    });
  await cdp.send("Page.startScreencast", { format: "png", everyNthFrame: 1 });
  // The first frame is the state before the action.
  for (const deadline = Date.now() + 2000; !frames.length && Date.now() < deadline; )
    await new Promise((r) => setTimeout(r, 10));
  const from = (await state()).n;
  return {
    async stop() {
      const { n: to, masks = [], times = [], inputs = [] } = await state();
      await cdp.send("Page.stopScreencast").catch(() => undefined);
      if (marker) await page.evaluate(markerOff).catch(() => undefined);
      await cdp.detach().catch(() => undefined);
      return { frames, from, to, masks, times, inputs };
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

/** Marker counters the screencast never delivered, as [first, last] runs relative to the window start. */
// fallow-ignore-next-line complexity
function gaps(seen, from, to) {
  const runs = [];
  for (let c = from; c <= to; c++)
    if (!seen.has(c)) {
      const last = runs.at(-1);
      if (last && last[1] === c - from - 1) last[1] = c - from;
      else runs.push([c - from, c - from]);
    }
  return runs;
}

const showsAfter = (row, tolPx) =>
  Object.values(row.diffs).every(([, vsAfter]) => vsAfter <= tolPx);

/**
 * Edit-to-paint: frames from the committing input until the preview shows the after-state for good, and the ms from
 * the input to that frame's rAF. One frame is the next paint; null when the window logged no input.
 */
// fallow-ignore-next-line complexity
function editToPaint(rows, input, times, tolPx) {
  if (!input) return null;
  let lastOff = null;
  for (const r of rows) if (r.counter > input.n && !showsAfter(r, tolPx)) lastOff = r.counter;
  const at = lastOff === null ? input.n + 1 : lastOff + 1;
  return { frames: at - input.n, ms: times[at] == null ? null : times[at] - input.t };
}

/**
 * A frame is bad (a flash) when some pane differs from the before frame and from the after frame by more pixels than
 * a 0.5 px shift of the element's perimeter moves. Coverage is marker counters seen over counters in the window.
 * `frames` holds each frame's marker counter and per-pane [vsBefore, vsAfter] differing pixel counts.
 */
// fallow-ignore-next-line complexity
export function classify(frames, { from, to, times = [], inputs = [] }, tolPx) {
  // The screencast can deliver one frame twice; with the marker on, each counter counts once.
  const indexed = frames.map((r, frame) => ({ ...r, frame }));
  const rows =
    from === null ? indexed : indexed.filter((r, i) => r.counter !== frames[i - 1]?.counter);
  const seen = new Set(rows.map((r) => r.counter).filter((c) => c >= from && c <= to));
  const span = from === null || to === null ? null : to - from + 1;
  const bad = [];
  for (const r of rows) {
    const panes = Object.entries(r.diffs)
      .filter(([, [vsBefore, vsAfter]]) => vsBefore > tolPx && vsAfter > tolPx)
      .map(([k, [vsBefore, vsAfter]]) => ({ pane: k, vsBefore, vsAfter }));
    if (panes.length) bad.push({ frame: r.frame, counter: r.counter, panes });
  }
  let [longest, run] = [0, 0];
  for (const r of rows) {
    run = bad.some((x) => x.frame === r.frame) ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  return {
    frames: rows.length,
    rafFrames: span,
    coverage: span ? seen.size / span : null,
    missing: span ? gaps(seen, from, to) : null,
    bad,
    longest,
    input: inputs[0] ?? null,
    paint: editToPaint(rows, inputs[0], times, tolPx),
  };
}

// fallow-ignore-next-line complexity
async function scoreWindow(decoder, win, regions, tolPx) {
  const b = win.before ?? win.frames[0];
  const a = win.after ?? win.frames.at(-1);
  if (!b || !a) return { frames: 0, coverage: 0, bad: [], longest: 0, paint: null };
  const rows = await decoder.evaluate(
    compareFrames,
    win.frames,
    b,
    a,
    regions,
    dedupe(win.masks ?? []),
    COLOUR_TOL,
  );
  return classify(rows, win, tolPx);
}

const dedupe = (rects) =>
  [...new Set(rects.map((r) => r.join(",")))].map((k) => k.split(",").map(Number));

// PNG is lossless; this absorbs only anti-aliasing and subpixel text noise between otherwise equal frames.
const COLOUR_TOL = 24;
const MIN_COVERAGE = 0.9;

// The inputs that commit an edit; the reload window has none and scores flashes only.
const COMMITTING = ["release", "undo", "redo"];

/** Scores every window of a case; the offending frames go to `evidence.flashFrames` as PNG. */
// fallow-ignore-next-line complexity
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
  const paints = COMMITTING.filter((k) => out[k]).map((k) => out[k].paint);
  return {
    bad: all.reduce((n, w) => n + w.bad.length, 0),
    longest: Math.max(0, ...all.map((w) => w.longest)),
    coverage,
    uncovered: !(coverage >= MIN_COVERAGE),
    // The slowest committing input; unknown (null) when any of them logged no input.
    paint: paints.some((p) => !p)
      ? null
      : paints.reduce((a, p) => (p.frames > a.frames ? p : a), { frames: 0, ms: 0 }),
    regions,
    tolPx,
    windows: out,
  };
}
