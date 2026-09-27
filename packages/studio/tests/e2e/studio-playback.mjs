#!/usr/bin/env node
// Plays the studio-playback fixture with the Catalog open: exact work counts for perf-ratchet.mjs, and, against
// STUDIO_BASE_URL (the base branch's Studio on this runner, alternating runs), exits 1 when median main-thread
// CPU per frame exceeds MAX_CPU_RATIO of the base's. Chrome runs uncapped, so a frame costs what the page costs.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import puppeteer from "puppeteer-core";
import { resolveChromeExecutable } from "./chrome-executable.mjs";

const HEAD_URL = process.env.STUDIO_URL;
const BASE_URL = process.env.STUDIO_BASE_URL;
const ROUNDS = Number(process.env.STUDIO_PLAYBACK_ROUNDS || 3);
const PLAY_MS = 4_000;
const MAX_CPU_RATIO = 1.15;
const LAYER_READ_TIME_S = 5;
// A catalog the size of the real registry, served by this script so the counts never follow it.
const CATALOG_SIZE = 400;
const CATEGORIES = ["transitions", "vfx", "social", "data", "scenes", "captions", "effects"];

if (!HEAD_URL) {
  console.error("STUDIO_URL is required and must point at the studio-playback fixture");
  process.exit(2);
}
const executablePath = resolveChromeExecutable();
if (!executablePath) {
  console.error("No Chrome executable found; set PUPPETEER_EXECUTABLE_PATH");
  process.exit(2);
}
const gsapSource = readFileSync(
  createRequire(import.meta.url).resolve("gsap/dist/gsap.min.js"),
  "utf8",
);

const catalog = Array.from({ length: CATALOG_SIZE }, (_, i) => ({
  name: `perf-block-${i}`,
  type: "hyperframes:block",
  title: `Block ${i}`,
  description: `Catalog entry ${i} for the playback gate`,
  tags: [CATEGORIES[i % CATEGORIES.length]],
  duration: 5,
  preview: { poster: `/__studio-playback/poster/${i}.svg` },
}));
const poster = (i) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="hsl(${(i * 37) % 360} 60% 40%)"/><text x="40" y="200" font-size="64" fill="#fff">${i}</text></svg>`;

/** A response for each fixture this script serves in place of the network, by URL. */
// fallow-ignore-next-line complexity
function fixtureResponse(url) {
  if (url.pathname.endsWith("/api/registry/blocks")) {
    return { contentType: "application/json", body: JSON.stringify(catalog) };
  }
  const posterMatch = /^\/__studio-playback\/poster\/(\d+)\.svg$/.exec(url.pathname);
  if (posterMatch) return { contentType: "image/svg+xml", body: poster(Number(posterMatch[1])) };
  const isGsap = url.hostname === "cdn.jsdelivr.net" && url.pathname.endsWith("/gsap.min.js");
  return isGsap ? { contentType: "application/javascript", body: gsapSource } : null;
}

/** Serves the catalog, its posters and GSAP locally, and refuses every other off-origin request. */
async function serveFixtures(page, origin) {
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    const url = new URL(request.url());
    const fixture = fixtureResponse(url);
    if (fixture) return request.respond(fixture);
    return url.origin === origin ? request.continue() : request.abort();
  });
}

/** Counts, per composition animation frame, every seek of a GSAP timeline, silent ones included. */
function instrumentPlayback() {
  window.previewWindow = () =>
    document.querySelector("hyperframes-player").shadowRoot.querySelector("iframe").contentWindow;
  const win = window.previewWindow();
  const timelines = Object.values(win.__timelines).filter(
    (tl) => typeof tl?.totalTime === "function",
  );
  if (timelines.length === 0) throw new Error("the composition registered no timeline to watch");
  const state = (window.__studioPlayback = { on: false, frames: [], current: 0 });
  // Studio wraps each timeline's own totalTime, so count on the instance, outside those wrappers.
  for (const tl of timelines) {
    const totalTime = tl.totalTime;
    tl.totalTime = function () {
      if (arguments.length > 0 && state.on) state.current += 1;
      return totalTime.apply(this, arguments);
    };
  }
  const frame = () => {
    if (state.on) state.frames.push(state.current);
    state.current = 0;
    win.requestAnimationFrame(frame);
  };
  win.requestAnimationFrame(frame);
}

/** The page's renderer main thread (the one producing frames; Chrome may run more than one), in time order. */
function mainThreadEvents(traceEvents) {
  const frames = new Map();
  for (const e of traceEvents) {
    if (e.name !== "ProxyMain::BeginMainFrame") continue;
    const key = `${e.pid}:${e.tid}`;
    frames.set(key, (frames.get(key) ?? 0) + 1);
  }
  const mains = traceEvents.filter(
    (e) => e.ph === "M" && e.name === "thread_name" && e.args.name === "CrRendererMain",
  );
  const count = (e) => frames.get(`${e.pid}:${e.tid}`) ?? 0;
  const main = mains.reduce((best, e) => (count(e) > count(best) ? e : best), mains[0]);
  return traceEvents
    .filter((e) => e.pid === main.pid && e.tid === main.tid && e.ph === "X")
    .sort((a, b) => a.ts - b.ts);
}

/** Main-thread CPU per produced frame: top-level task CPU between consecutive BeginMainFrames. */
// fallow-ignore-next-line complexity
function cpuPerFrameMs(traceEvents) {
  const events = mainThreadEvents(traceEvents);
  const frameStarts = events.filter((e) => e.name === "ProxyMain::BeginMainFrame").map((e) => e.ts);
  const cpu = new Array(Math.max(0, frameStarts.length - 1)).fill(0);
  let taskEnd = -1;
  for (const event of events) {
    if (event.ts < taskEnd) continue; // nested inside the previous top-level task
    taskEnd = event.ts + event.dur;
    const frame = frameStarts.findLastIndex((start) => start <= event.ts);
    if (frame >= 0 && frame < cpu.length) cpu[frame] += (event.tdur ?? event.dur) / 1000;
  }
  return cpu;
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : Number.NaN;
};
const round = (value) => Math.round(value * 100) / 100;

async function measure(url) {
  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu-vsync",
      "--disable-frame-rate-limit",
      "--window-size=1600,900",
    ],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 900 });
    await serveFixtures(page, new URL(url).origin);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForFunction(
      () => {
        const play = document.querySelector('button[aria-label="Play"]');
        return play instanceof HTMLButtonElement && !play.disabled;
      },
      { timeout: 120_000, polling: 50 },
    );
    // #4529's setup: closing the Compositions tab leaves the Catalog showing.
    await page.click('[aria-label="Close Compositions"]');
    await page.waitForFunction(
      () => document.querySelectorAll('img[src*="/__studio-playback/poster/"]').length > 0,
      { timeout: 30_000, polling: 100 },
    );
    // Posters below the panel's fold are lazy and never load, so wait for the first rows only.
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('img[src*="/__studio-playback/poster/"]')]
          .slice(0, 4)
          .every((img) => img.complete),
      { timeout: 30_000, polling: 100 },
    );
    await page.evaluate(instrumentPlayback);
    await page.mouse.move(0, 0);
    // Play and pause go through Studio's Space shortcut and the runtime's player, which both builds share.
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press("Space");
    await page.waitForFunction(() => previewWindow().__player?.isPlaying?.() === true, {
      timeout: 10_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 500));

    await page.tracing.start({ categories: ["devtools.timeline", "toplevel", "cc"] });
    await page.evaluate(() => {
      window.__studioPlayback.on = true;
    });
    await new Promise((resolve) => setTimeout(resolve, PLAY_MS));
    const counts = await page.evaluate(() => {
      window.__studioPlayback.on = false;
      // The Catalog's own subtree: the nearest ancestor of its search box that holds its posters.
      let panel = document.querySelector('input[aria-label="Search blocks"]');
      while (panel && !panel.querySelector('img[src*="/__studio-playback/poster/"]')) {
        panel = panel.parentElement;
      }
      return {
        catalogElements: panel ? panel.querySelectorAll("*").length : -1,
        seekFrames: window.__studioPlayback.frames,
      };
    });
    const trace = JSON.parse(Buffer.from(await page.tracing.stop()).toString("utf8"));
    // The film's own layers come and go with its tweens, so layers are read paused at one film time.
    await page.evaluate(() => previewWindow().__player.pause());
    await page.evaluate(
      (t) => document.querySelector("hyperframes-player").seek(t),
      LAYER_READ_TIME_S,
    );
    await page.waitForFunction(
      (t) => Math.abs(previewWindow().__player?.getTime?.() - t) < 0.01,
      { timeout: 10_000 },
      LAYER_READ_TIME_S,
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    const cdp = await page.createCDPSession();
    const layers = new Promise((resolve) =>
      cdp.on("LayerTree.layerTreeDidChange", (event) => event.layers && resolve(event.layers)),
    );
    await cdp.send("LayerTree.enable");
    const compositedLayers = (await layers).length;
    const cpu = cpuPerFrameMs(trace.traceEvents ?? trace);
    if (cpu.length === 0) throw new Error(`no frames captured while playing ${url}`);
    const seekFrames = counts.seekFrames.slice(1);
    return {
      browser: await browser.version(),
      frames: cpu.length,
      cpuMedianMs: round(median(cpu)),
      workCounts: {
        "playing.catalogElements": counts.catalogElements,
        "paused.compositedLayers": compositedLayers,
        "playing.maxSeeksPerFrame": seekFrames.length ? Math.max(...seekFrames) : -1,
      },
    };
  } finally {
    await browser.close();
  }
}

const head = [];
const base = [];
for (let round_ = 0; round_ < ROUNDS; round_ += 1) {
  // Alternate which build goes first, so a runner that slows over the job does not favour one.
  if (BASE_URL && round_ % 2 === 1) base.push(await measure(BASE_URL));
  head.push(await measure(HEAD_URL));
  if (BASE_URL && round_ % 2 === 0) base.push(await measure(BASE_URL));
}
// Counts must repeat exactly across runs of one build, or the ratchet would fail at random.
const countSets = new Set(head.map((run) => JSON.stringify(run.workCounts)));
if (countSets.size !== 1) {
  console.error(`work counts differ between runs of one build: ${[...countSets].join(" vs ")}`);
  process.exit(1);
}
// Layer and element counts differ between Chrome releases, so they are only comparable on the recorded one.
const ceilingsPath = fileURLToPath(new URL("./perf-ceilings.json", import.meta.url));
const recordedBrowser = JSON.parse(readFileSync(ceilingsPath, "utf8"))["studio-playback"]?.browser;
const measuredBrowser = /\/(\d+)\./.exec(head[0].browser)?.[1];
if (recordedBrowser && measuredBrowser !== recordedBrowser) {
  console.error(
    `studio-playback counts are recorded on Chrome ${recordedBrowser} but this ran Chrome ${measuredBrowser}: ` +
      "run it in the CI job, or take new ceilings from that job's evidence",
  );
  process.exit(1);
}
const evidence = {
  journey: "studio-playback",
  browser: head[0].browser,
  workCounts: head[0].workCounts,
  cpuMedianMsPerRun: head.map((run) => run.cpuMedianMs),
  framesPerRun: head.map((run) => run.frames),
};
let failed = false;
if (BASE_URL) {
  const headMs = median(head.map((run) => run.cpuMedianMs));
  const baseMs = median(base.map((run) => run.cpuMedianMs));
  evidence.ab = {
    headCpuMedianMs: headMs,
    baseCpuMedianMs: baseMs,
    baseCpuMedianMsPerRun: base.map((run) => run.cpuMedianMs),
    baseWorkCounts: base[0].workCounts,
    ratio: round(headMs / baseMs),
    maxRatio: MAX_CPU_RATIO,
  };
  failed = headMs > baseMs * MAX_CPU_RATIO;
}
console.log(JSON.stringify(evidence, null, 2));
if (failed) {
  console.error(
    `FAIL main-thread CPU per frame ${evidence.ab.headCpuMedianMs} ms against the base's ${evidence.ab.baseCpuMedianMs} ms (x${evidence.ab.ratio}, limit x${MAX_CPU_RATIO})`,
  );
  process.exit(1);
}
