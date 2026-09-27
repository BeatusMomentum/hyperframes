import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
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

test(
  "a failed whisper run reports the CLI's last lines, not every spinner redraw",
  { skip: process.platform === "win32" },
  () => {
    const root = mkdtempSync(join(tmpdir(), "media-use-transcribe-"));
    try {
      const bin = join(root, "bin");
      mkdirSync(bin);
      writeFileSync(
        join(bin, "npx"),
        `#!/bin/sh\ni=0\nwhile [ $i -lt 3000 ]; do printf '\\033[1G\\033[J◒  Checking whisper...\\n' >&2; i=$((i+1)); done\n` +
          `echo "◇  Captions skipped — run: hyperframes models install parakeet" >&2\nexit 1\n`,
      );
      chmodSync(join(bin, "npx"), 0o755);
      const input = join(root, "in.wav");
      writeFileSync(input, "");
      const script = fileURLToPath(new URL("./transcribe.mjs", import.meta.url));
      const res = spawnSync(
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
      const { error } = JSON.parse(res.stdout.trim());
      assert.match(error, /hyperframes models install parakeet/);
      assert.ok(error.length < 1000, `error is ${error.length} chars`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
