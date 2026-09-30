/** Teleport: per painted frame, the dragged element's box against the box the pointer put it at. */
import { COMPOSITION } from "./grid.mjs";
import {
  centre,
  compositionMapper,
  dist,
  localToQuad,
  mid,
  parseInset,
  quadToLocal,
  visibleQuad,
} from "./geometry.mjs";

const LIMIT_PX = 0.5;

/**
 * Page script for the top frame: after each paint, the pointer and the element's quad, all in top-frame px.
 * A quad is the box's centre plus its composed 2D linear transform, which DOM rects alone cannot give.
 */
export function frameSampler() {
  if (window.top !== window) return;
  const rec = { on: false, selector: null, pointer: null, down: false, samples: [] };
  window.__editBenchFrames = rec;
  for (const type of ["pointerdown", "pointermove", "pointerup"])
    window.addEventListener(
      type,
      (e) => {
        rec.pointer = [e.clientX, e.clientY];
        rec.down = type !== "pointerup";
      },
      true,
    );
  const mul = (a, b) => [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
  ];
  const apply = (m, [x, y]) => [m[0] * x + m[2] * y, m[1] * x + m[3] * y];
  const rotation = (value) => {
    const parts = value === "none" ? [] : value.trim().split(/\s+/);
    const deg = parts.length
      ? Number.parseFloat(parts.at(-1)) * Math.sign(Number(parts.at(-2) ?? 1))
      : 0;
    const r = (deg * Math.PI) / 180;
    return [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r)];
  };
  // CSS applies translate, rotate, scale, then transform; only the linear part matters around the centre.
  const ownLinear = (node) => {
    const s = node.ownerDocument.defaultView.getComputedStyle(node);
    const [sx, sy = sx] = s.scale === "none" ? [1] : s.scale.split(/\s+/).map(Number);
    const t = s.transform === "none" ? null : new DOMMatrix(s.transform);
    return mul(mul(rotation(s.rotate), [sx, 0, 0, sy]), t ? [t.a, t.b, t.c, t.d] : [1, 0, 0, 1]);
  };
  const parentOf = (node) => node.parentElement ?? node.getRootNode().host ?? null;
  const linear = (node) => {
    let m = [1, 0, 0, 1];
    for (let n = node; n; n = parentOf(n)) m = mul(ownLinear(n), m);
    return m;
  };
  /** The element's quad in top-frame px, crossing each iframe through its element's own transform. */
  const quadOf = (el) => {
    const r = el.getBoundingClientRect();
    let c = [r.left + r.width / 2, r.top + r.height / 2];
    let m = linear(el);
    for (let win = el.ownerDocument.defaultView; win !== window; win = win.parent) {
      const f = win.frameElement;
      const fr = f.getBoundingClientRect();
      const fm = linear(f);
      const fs = getComputedStyle(f);
      const inset = [
        f.clientLeft + parseFloat(fs.paddingLeft),
        f.clientTop + parseFloat(fs.paddingTop),
      ];
      const local = [c[0] + inset[0] - f.offsetWidth / 2, c[1] + inset[1] - f.offsetHeight / 2];
      const d = apply(fm, local);
      c = [fr.left + fr.width / 2 + d[0], fr.top + fr.height / 2 + d[1]];
      m = mul(fm, m);
    }
    const [w, h] = [el.offsetWidth, el.offsetHeight];
    const corner = (u, v) => {
      const d = apply(m, [u * w, v * h]);
      return [c[0] + d[0], c[1] + d[1]];
    };
    return [corner(-0.5, -0.5), corner(0.5, -0.5), corner(0.5, 0.5), corner(-0.5, 0.5)];
  };
  // Studio's previews sit in <hyperframes-player> shadow roots, which window.frames does not list.
  const previewWindows = () =>
    Array.from(document.querySelectorAll("iframe, hyperframes-player"))
      .flatMap((e) => (e.shadowRoot ? Array.from(e.shadowRoot.querySelectorAll("iframe")) : [e]))
      .map((e) => e.contentWindow)
      .filter((f) => {
        try {
          return f.location.pathname.includes("/preview");
        } catch {
          return false; // cross-origin
        }
      });
  // The largest visible preview holding the element; Studio loads edits in a hidden shadow frame.
  // fallow-ignore-next-line complexity
  const findElement = (selector) => {
    let best = null;
    for (const f of previewWindows()) {
      const el = f.document.querySelector(selector);
      const fe = f.frameElement;
      if (!el || !fe.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
      const r = fe.getBoundingClientRect();
      if (!best || r.width * r.height > best.area) best = { el, area: r.width * r.height };
    }
    return best?.el ?? null;
  };
  const read = () => {
    const el = findElement(rec.selector);
    const root = el?.ownerDocument.querySelector('[data-composition-id="main"]');
    const outline = document.querySelector("[data-dom-edit-crop-frame] > div.border-dashed");
    rec.samples.push({
      t: performance.now(),
      pointer: rec.pointer,
      down: rec.down,
      ...(el &&
        root && {
          root: quadOf(root),
          quad: quadOf(el),
          size: [el.offsetWidth, el.offsetHeight],
          clip: el.ownerDocument.defaultView.getComputedStyle(el).clipPath,
        }),
      ...(outline && { outline: quadOf(outline) }),
    });
  };
  // A message posted from rAF runs after that frame's paint, so it reads what the frame showed.
  const channel = new MessageChannel();
  channel.port1.onmessage = () => {
    if (!rec.on) return;
    try {
      read();
    } catch (error) {
      rec.samples.push({ t: performance.now(), error: String(error) });
    }
  };
  const loop = () => {
    if (rec.on) channel.port2.postMessage(null);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

export const startFrames = (page, selector) =>
  page.evaluate((sel) => {
    const rec = window.__editBenchFrames;
    Object.assign(rec, { on: true, selector: sel, samples: [] });
  }, selector);

export const stopFrames = (page) =>
  page.evaluate(() => {
    const rec = window.__editBenchFrames;
    rec.on = false;
    return rec.samples;
  });

const boxOf = (s, map) => {
  const quad = s.quad.map(map.toComp);
  const size = { width: s.size[0], height: s.size[1] };
  return { quad, size, visible: visibleQuad(quad, size, parseInset(s.clip)) };
};

/**
 * The points a gesture moves, per frame, each with where the pointer puts it. Move and rotate drag the
 * pressed point itself (for rotate, the handle: its angle at the handle radius, plus any shift of the box).
 * Resize drags the corner. Crop drags the outline's edge while selected, then the clipped edge, and the
 * element under it must hold still.
 */
// fallow-ignore-next-line complexity
function trackers(gesture, first, p0) {
  const b = boxOf(first, first.map);
  const follow = (grab) => {
    const g0 = grab(first);
    return { grab, implied: (p) => [g0[0] + p[0] - p0[0], g0[1] + p[1] - p0[1]] };
  };
  if (gesture === "resize") return [follow((s) => boxOf(s, s.map).visible[2])];
  if (gesture === "crop") {
    const c0 = centre(b.quad);
    const edge = (s) => {
      const q = s.outline ? s.outline.map(s.map.toComp) : boxOf(s, s.map).visible;
      return mid(q[1], q[2]);
    };
    return [follow(edge), { grab: (s) => centre(boxOf(s, s.map).quad), implied: () => c0 }];
  }
  const local = quadToLocal(b.quad, b.size, p0);
  const grab = (s) => {
    const m = boxOf(s, s.map);
    return localToQuad(m.quad, m.size, local);
  };
  if (gesture !== "rotate") return [follow(grab)];
  const c = centre(b.visible);
  const angle = (p) => Math.atan2(p[1] - c[1], p[0] - c[0]);
  const [dx, dy] = [p0[0] - c[0], p0[1] - c[1]];
  return [
    {
      grab,
      implied: (p) => {
        const a = angle(p) - angle(p0);
        return [
          c[0] + dx * Math.cos(a) - dy * Math.sin(a),
          c[1] + dx * Math.sin(a) + dy * Math.cos(a),
        ];
      },
    },
  ];
}

const round = (v) => Math.round(v * 100) / 100;

/**
 * Scores the frames from before press to settle. A frame fails when a tracked point moved more than the
 * pointer did since the previous frame, or sits where the pointer never put it (only the release point
 * once up).
 */
// fallow-ignore-next-line complexity
export function scoreTeleport(gesture, samples) {
  const frames = samples
    .filter((s) => s.quad && s.pointer)
    .map((s) => ({ ...s, map: compositionMapper(s.root, COMPOSITION) }));
  if (frames.length < 2) {
    const count = (f) => samples.filter(f).length;
    const failed = samples.find((s) => s.error)?.error;
    return {
      max: null,
      error: `${samples.length} frames: ${count((s) => s.quad)} found the element, ${count((s) => s.pointer)} had a pointer${failed ? `; ${failed}` : ""}`,
    };
  }
  const pointer = (s) => s.map.toComp(s.pointer);
  const tracked = trackers(gesture, frames[0], pointer(frames[0])).map((t) => ({
    ...t,
    allowed: [],
    prev: null,
  }));
  let worst = { max: 0, frame: 0, kind: null, point: 0 };
  const trace = [];
  let [pressed, released] = [false, false];
  for (const [i, s] of frames.entries()) {
    pressed ||= s.down;
    released ||= pressed && !s.down;
    // fallow-ignore-next-line complexity
    const row = tracked.map((t, k) => {
      const [g, want] = [t.grab(s), t.implied(pointer(s))];
      if (!released) t.allowed.push(want);
      const places = released ? [t.allowed.at(-1)] : t.allowed;
      const off = Math.min(...places.map((a) => dist(g, a)));
      const jump = t.prev ? dist(g, t.prev.g) - dist(want, t.prev.want) : 0;
      t.prev = { g, want };
      if (jump > worst.max) worst = { max: jump, frame: i, kind: "jump", point: k };
      if (off > worst.max) worst = { max: off, frame: i, kind: "off", point: k };
      return { box: g.map(round), pointer: want.map(round), jump: round(jump), off: round(off) };
    });
    trace.push({ t: round(s.t - frames[0].t), down: s.down, points: row });
  }
  return {
    ...worst,
    pass: worst.max <= LIMIT_PX,
    frames: frames.length,
    unmeasured: samples.length - frames.length,
    // Kept only when it fails: each tracked point and where the pointer put it, every frame.
    trace: worst.max > LIMIT_PX ? trace : undefined,
  };
}
