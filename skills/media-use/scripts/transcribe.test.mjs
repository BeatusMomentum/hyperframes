import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The stub stands in for `npx hyperframes transcribe <in> --dir <dir>` and writes the CLI's flat array.
test(
  "the whisper path reports the word count of the CLI's flat transcript",
  { skip: process.platform === "win32" },
  () => {
    const root = mkdtempSync(join(tmpdir(), "media-use-transcribe-"));
    try {
      const bin = join(root, "bin");
      mkdirSync(bin);
      writeFileSync(
        join(bin, "npx"),
        `#!/bin/sh\nwhile [ "$1" != "--dir" ]; do shift; done\n` +
          `echo '[{"text":"a","start":0,"end":1},{"text":"b","start":1,"end":2}]' > "$2/transcript.json"\n`,
      );
      chmodSync(join(bin, "npx"), 0o755);
      const input = join(root, "in.wav");
      writeFileSync(input, "");
      const script = fileURLToPath(new URL("./transcribe.mjs", import.meta.url));
      const out = execFileSync(
        process.execPath,
        [script, "--input", input, "--engine", "whisper", "--json"],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            HYPERFRAMES_MEDIA_HOME: join(root, "home"),
            HYPERFRAMES_NO_TELEMETRY: "1",
          },
        },
      );
      assert.equal(JSON.parse(out.trim()).words, 2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
