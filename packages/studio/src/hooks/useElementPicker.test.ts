// @vitest-environment jsdom
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ensureHfIds } from "@hyperframes/parsers/hf-ids";
import { runtimeProtocolMetadata } from "@hyperframes/core/runtime/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { useElementPicker } from "./useElementPicker";

// As the host leaves it on disk: hf-ids pinned, no element ids.
const SAVED = ensureHfIds(`<!doctype html><html><body>
<div data-composition-id="main" data-start="0" data-duration="10">
<h1 class="clip" data-start="2" data-duration="3" data-track-index="0">Title</h1>
</div></body></html>`);

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

// The preview page: the saved markup plus what the runtime adds to it.
function mountPreview(mounted = "", page = SAVED): HTMLIFrameElement {
  const iframe = document.createElement("iframe");
  document.body.appendChild(iframe);
  const doc = iframe.contentDocument as Document;
  doc.open();
  doc.write(page);
  doc.close();
  const title = doc.querySelector("h1");
  if (title) title.style.cssText = "visibility: hidden; display: none";
  doc.body.append(Object.assign(doc.createElement("script"), { textContent: "/* runtime */" }));
  doc.body.insertAdjacentHTML("beforeend", mounted);
  return iframe;
}

function mountPicker(
  files: Record<string, string>,
  selector = "h1",
  mounted = "",
  hostAppliesWrites = true,
  preview?: { page: string; id: string },
) {
  const iframe = mountPreview(mounted, preview?.page);
  const synced: Record<string, string>[] = [];
  const toasts: [string, string | undefined][] = [];
  let api: ReturnType<typeof useElementPicker> | null = null;
  let setHostFiles: (next: Record<string, string>) => void = () => {};
  // Like a Studio host: it holds the files in state and rerenders after each write.
  function Harness() {
    const [workspaceFiles, setFiles] = useState(files);
    setHostFiles = setFiles;
    api = useElementPicker(
      { current: iframe },
      {
        workspaceFiles,
        onSyncFiles: (changed) => {
          synced.push(changed);
          if (hostAppliesWrites) setFiles((prev) => ({ ...prev, ...changed }));
        },
        showToast: (message, tone) => toasts.push([message, tone]),
      },
    );
    return null;
  }
  root = createRoot(document.createElement("div"));
  act(() => root?.render(React.createElement(Harness)));
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        source: iframe.contentWindow,
        data: {
          source: "hf-preview",
          type: "element-picked",
          elementInfo: { selector, tagName: "h1", id: preview?.id },
          ...runtimeProtocolMetadata(30),
        },
      }),
    );
  });
  const picker = () => api as ReturnType<typeof useElementPicker>;
  return {
    picker,
    synced,
    toasts,
    iframe,
    setHostFiles: (next: Record<string, string>) => act(() => setHostFiles(next)),
  };
}

describe("an edit to a picked element without an id", () => {
  it("writes only that edit into the saved file", () => {
    const { picker, synced } = mountPicker({ "index.html": SAVED });
    expect(picker().pickedElement?.selector).toBe("h1");
    act(() => picker().setStyle("color", "red"));
    expect(synced).toHaveLength(1);
    const written = synced[0]?.["index.html"] ?? "";
    expect(written).toMatch(/<h1 [^>]*style="color: red"[^>]*>Title<\/h1>/);
    expect(written).not.toContain("display: none");
    expect(written).not.toContain("/* runtime */");
  });

  it("persists a text edit", () => {
    const { picker, synced } = mountPicker({ "index.html": SAVED });
    act(() => picker().setTextContent("Hello"));
    expect(synced[0]?.["index.html"]).toMatch(/>Hello<\/h1>/);
  });

  // The same h1 in index.html and compositions/b.html, so both carry one hf-id.
  const SUB = ensureHfIds(`<template><div data-composition-id="b">
<h1 class="clip" data-start="2" data-duration="3" data-track-index="0">Title</h1>
</div></template>`);
  const subH1 = new DOMParser()
    .parseFromString(SUB, "text/html")
    .querySelector("template")
    ?.content.querySelector("h1");
  const host = `<div data-composition-file="compositions/b.html">${subH1?.outerHTML}</div>`;

  it.each([
    ["index.html first", { "index.html": SAVED, "compositions/b.html": SUB }],
    ["the sub-composition first", { "compositions/b.html": SUB, "index.html": SAVED }],
  ])("writes a twin element into its own file (%s)", (_order, files) => {
    expect(SAVED).toContain(`data-hf-id="${subH1?.getAttribute("data-hf-id")}"`);
    const inSub = mountPicker(files, "[data-composition-file] h1", host);
    act(() => inSub.picker().setStyle("color", "red"));
    expect(inSub.synced.map((changed) => Object.keys(changed))).toEqual([["compositions/b.html"]]);
    act(() => root?.unmount());
    const inRoot = mountPicker(files, "h1", host);
    act(() => inRoot.picker().setStyle("color", "red"));
    expect(inRoot.synced.map((changed) => Object.keys(changed))).toEqual([["index.html"]]);
  });

  it("keeps both of two edits made before the host rerenders", () => {
    const { picker, synced } = mountPicker({ "index.html": SAVED });
    act(() => {
      picker().setStyle("color", "red");
      picker().setStyle("background", "blue");
    });
    expect(synced.at(-1)?.["index.html"]).toMatch(/<h1 [^>]*style="color: red; background: blue"/);
  });

  it("builds the next edit on a file the host changed meanwhile", () => {
    const { picker, synced, setHostFiles } = mountPicker({ "index.html": SAVED });
    act(() => picker().setStyle("color", "red"));
    setHostFiles({ "index.html": SAVED.replace(">Title<", ">Renamed<") });
    act(() => picker().setStyle("background", "blue"));
    const written = synced.at(-1)?.["index.html"] ?? "";
    expect(written).toContain(">Renamed</h1>");
    expect(written).not.toContain("color: red");
  });

  it("builds the next edit on the host's undo", () => {
    const { picker, synced, setHostFiles } = mountPicker({ "index.html": SAVED });
    act(() => picker().setStyle("color", "red"));
    setHostFiles({ "index.html": SAVED });
    act(() => picker().setStyle("background", "blue"));
    expect(synced.at(-1)?.["index.html"]).not.toContain("color: red");
  });

  it("keeps later edits while the host has applied only the first", () => {
    const { picker, synced, setHostFiles } = mountPicker({ "index.html": SAVED }, "h1", "", false);
    act(() => {
      picker().setStyle("color", "red");
      picker().setStyle("background", "blue");
    });
    setHostFiles(synced[0] as Record<string, string>);
    act(() => picker().setStyle("border", "0"));
    expect(synced.at(-1)?.["index.html"]).toMatch(
      /style="color: red; background: blue; border: 0"/,
    );
  });

  it("writes nothing when no saved file holds the element", () => {
    const { picker, synced } = mountPicker({ "index.html": "<div>other</div>" });
    act(() => picker().setStyle("color", "red"));
    expect(synced).toEqual([]);
  });
});

describe("an edit that cannot be saved", () => {
  const saved =
    '<div data-composition-id="main"><span id="dupe" data-hf-id="hf-x" data-tone="warm">a</span>' +
    '<span id="dupe" data-hf-id="hf-x">b</span></div>';
  const page = `<!doctype html><html><body>${saved}</body></html>`;

  it("puts a data attribute and text back as the file has them", () => {
    const { picker, synced, toasts, iframe } = mountPicker(
      { "index.html": saved },
      "span:nth-of-type(1)",
      "",
      true,
      { page, id: "dupe" },
    );
    const shownBefore = picker().pickedElement;
    act(() => picker().setDataAttr("tone", "cold"));
    act(() => picker().setTextContent("changed"));
    const live = iframe.contentDocument?.querySelector("span") as HTMLElement;
    expect([live.getAttribute("data-tone"), live.textContent]).toEqual(["warm", "a"]);
    expect(picker().pickedElement?.textContent).toBe(shownBefore?.textContent);
    expect(picker().pickedElement?.dataAttributes).toEqual(shownBefore?.dataAttributes);
    expect(synced).toEqual([]);
    expect(toasts).toHaveLength(2);
  });
});

describe("an edit that cannot be saved, put back exactly", () => {
  it("restores an important inline style and child elements as they were", () => {
    const saved =
      '<div data-composition-id="main"><p id="dupe" data-hf-id="hf-x" style="color: blue !important">' +
      '<b>bold</b> text</p><p id="dupe" data-hf-id="hf-x">b</p></div>';
    const { picker, iframe } = mountPicker({ "index.html": saved }, "p:nth-of-type(1)", "", true, {
      page: `<!doctype html><html><body>${saved}</body></html>`,
      id: "dupe",
    });
    const live = iframe.contentDocument?.querySelector("p") as HTMLElement;
    const shownBefore = picker().pickedElement?.computedStyles;
    act(() => picker().setStyle("color", "red"));
    act(() => picker().setTextContent("flat"));
    expect(picker().pickedElement?.computedStyles).toEqual(shownBefore);
    expect(live.getAttribute("style")).toBe("color: blue !important");
    expect(live.innerHTML).toBe("<b>bold</b> text");
  });

  it("refuses an id-only element whose id repeats in its file instead of writing the first", () => {
    const saved =
      '<div data-composition-id="main"><span id="dupe">a</span><span id="dupe">b</span></div>';
    const { picker, synced, toasts } = mountPicker(
      { "index.html": saved },
      "span:nth-of-type(2)",
      "",
      true,
      { page: `<!doctype html><html><body>${saved}</body></html>`, id: "dupe" },
    );
    act(() => picker().setStyle("color", "red"));
    expect(synced).toEqual([]);
    expect(toasts).toHaveLength(1);
  });
});

describe("an edit to a picked element whose id another scene shares", () => {
  it("writes the scene it was picked in, not the first file with that id", () => {
    const first =
      '<div data-composition-id="main"><span id="dupe" data-hf-id="hf-first">a</span></div>';
    const second = '<span id="dupe" data-hf-id="hf-second">b</span>';
    const page = `<!doctype html><html><body>${first}<div data-composition-id="second" data-composition-src="compositions/second.html">${second}</div></body></html>`;
    const { picker, synced } = mountPicker(
      { "index.html": first, "compositions/second.html": second },
      '[data-composition-id="second"] > #dupe',
      "",
      true,
      { page, id: "dupe" },
    );
    act(() => picker().setStyle("color", "red"));
    expect(Object.keys(synced[0] ?? {})).toEqual(["compositions/second.html"]);
    expect(synced[0]?.["compositions/second.html"]).toContain('style="color: red"');
  });

  it("writes the picked copy when source edits left two elements with one pinned hf-id", () => {
    const saved =
      '<div data-composition-id="main"><span id="original" data-hf-id="hf-x">a</span>' +
      '<span id="copy" data-hf-id="hf-x">b</span></div>';
    const { picker, synced } = mountPicker({ "index.html": saved }, "#copy", "", true, {
      page: `<!doctype html><html><body>${saved}</body></html>`,
      id: "copy",
    });
    act(() => picker().setStyle("color", "red"));
    expect(synced[0]?.["index.html"]).toContain('id="copy" data-hf-id="hf-x" style="color: red"');
    expect(synced[0]?.["index.html"]).toContain('id="original" data-hf-id="hf-x">');
  });

  it("writes by the id when the scene's data-composition-id has the same value", () => {
    const saved =
      '<div data-composition-id="intro"><h1 id="intro" data-hf-id="hf-x">a</h1>' +
      '<h1 id="copy" data-hf-id="hf-x">b</h1></div>';
    const { picker, synced } = mountPicker({ "index.html": saved }, "#intro", "", true, {
      page: `<!doctype html><html><body>${saved}</body></html>`,
      id: "intro",
    });
    act(() => picker().setStyle("color", "red"));
    expect(synced[0]?.["index.html"]).toContain('<div data-composition-id="intro">');
    expect(synced[0]?.["index.html"]).toContain('id="intro" data-hf-id="hf-x" style="color: red"');
  });

  it("reverts the preview and says why when neither the hf-id nor the id picks one element", () => {
    const saved =
      '<div data-composition-id="main"><span id="dupe" data-hf-id="hf-x">a</span>' +
      '<span id="dupe" data-hf-id="hf-x">b</span></div>';
    const { picker, synced, toasts, iframe } = mountPicker(
      { "index.html": saved },
      "span:nth-of-type(2)",
      "",
      true,
      {
        page: `<!doctype html><html><body>${saved}</body></html>`,
        id: "dupe",
      },
    );
    act(() => picker().setStyle("color", "red"));
    expect(synced).toEqual([]);
    const live = iframe.contentDocument?.querySelectorAll("span")[1] as HTMLElement;
    expect(live.style.color).toBe("");
    expect(toasts).toEqual([
      ["Couldn't save that change: the element isn't uniquely identifiable in its file.", "error"],
    ]);
  });

  it("reverts and says why when the scene is unknown and the hf-id is in two files", () => {
    const first = '<span id="dupe" data-hf-id="hf-x">a</span>';
    const second = '<span id="dupe" data-hf-id="hf-x">b</span>';
    const { picker, synced, toasts } = mountPicker(
      { "one.html": first, "two.html": second },
      "#dupe",
      "",
      true,
      { page: `<!doctype html><html><body>${first}</body></html>`, id: "dupe" },
    );
    act(() => picker().setStyle("color", "red"));
    expect(synced).toEqual([]);
    expect(toasts).toHaveLength(1);
  });

  it("still saves an element that has an id but no hf-id, by its id", () => {
    const saved = '<div data-composition-id="main"><span id="solo">a</span></div>';
    const { picker, synced } = mountPicker({ "index.html": saved }, "#solo", "", true, {
      page: `<!doctype html><html><body>${saved}</body></html>`,
      id: "solo",
    });
    act(() => picker().setStyle("color", "red"));
    expect(synced[0]?.["index.html"]).toContain('style="color: red"');
  });
});
