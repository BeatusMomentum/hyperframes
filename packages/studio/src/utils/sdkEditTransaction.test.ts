// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { openComposition } from "@hyperframes/sdk";
import { persistSdkCandidateMutation } from "./sdkEditTransaction";

vi.mock("./studioTelemetry", () => ({ trackStudioEvent: vi.fn() }));

// The live session still holds the 6 an earlier SDK write shrank to 4 on disk.
it("decides the length against the file on disk, not the live session's copy", async () => {
  const stale = [
    `<div data-hf-id="hf-root" data-composition-id="main" data-duration="6">`,
    `  <div data-hf-id="hf-a" data-start="0" data-duration="2"></div>`,
    `  <div data-hf-id="hf-b" data-start="2" data-duration="2"></div>`,
    `</div>`,
  ].join("\n");
  let disk = stale.replace(`data-duration="6"`, `data-duration="4"`);
  const live = await openComposition(stale, { history: false });
  const published: Array<Awaited<ReturnType<typeof openComposition>>> = [];
  const snapshot = live.serialize();

  const result = await persistSdkCandidateMutation(
    live,
    "index.html",
    snapshot,
    {
      editHistory: { recordEdit: vi.fn().mockResolvedValue(undefined) },
      writeProjectFile: vi.fn(async (_path: string, content: string) => {
        disk = content;
      }),
      readProjectFile: vi.fn(async () => disk),
      reloadPreview: vi.fn(),
      publishSession: ({ candidate }) => {
        published.push(candidate);
        return "published";
      },
    },
    (candidate) => candidate.setTiming("hf-b", { start: 3 }),
    { animationEnd: 0 },
    snapshot,
  );

  expect(result.status).toBe("committed");
  expect(disk).toContain(`data-composition-id="main" data-duration="5"`);
  live.dispose();
  for (const candidate of published) candidate.dispose();
});
