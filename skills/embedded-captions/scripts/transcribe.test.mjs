import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// A stub CLI answers as `transcribe --json` does when --engine auto ran Parakeet.
const STUB_CLI = `
const fs = require("fs"), path = require("path");
const project = process.argv[process.argv.indexOf("-d") + 1];
const transcriptPath = path.join(project, "cli-words.json");
fs.writeFileSync(transcriptPath, JSON.stringify([{ text: "hello", start: 0.1, end: 0.5 }]));
console.log(JSON.stringify({ ok: true, engine: "parakeet", model: "parakeet-tdt-0.6b-v3", transcriptPath }));
`;

/** Runs transcribe.cjs against a project whose hyperframes CLI is `stubCli`. */
function runWithStubCli(stubCli, check) {
  const root = mkdtempSync(join(tmpdir(), "embedded-captions-transcribe-"));
  try {
    const cliDir = join(root, "hf", "packages", "cli", "dist");
    mkdirSync(cliDir, { recursive: true });
    writeFileSync(join(cliDir, "cli.js"), stubCli);
    const project = join(root, "project");
    mkdirSync(project);
    writeFileSync(join(project, "source.mp4"), "");
    writeFileSync(join(project, "audio.mp3"), "");
    const res = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("./transcribe.cjs", import.meta.url)), project],
      {
        encoding: "utf8",
        env: { ...process.env, HYPERFRAMES_ROOT: join(root, "hf"), TRANSCRIBE_ENGINE: "whisper" },
      },
    );
    check(res, project);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("the CLI fallback labels the transcript with the engine the CLI ran", () => {
  runWithStubCli(STUB_CLI, (res, project) => {
    assert.equal(res.status, 0);
    const transcript = JSON.parse(readFileSync(join(project, "transcript.json"), "utf8"));
    assert.equal(transcript.engine, "parakeet(parakeet-tdt-0.6b-v3)");
  });
});

test("a failed CLI run reports the CLI's JSON error, not just the exit code", () => {
  const failing = `console.log(JSON.stringify({ ok: false, skipped: true, reason: "whisper_unavailable", error: "run: hyperframes models install parakeet" }));
process.exit(1);`;
  runWithStubCli(failing, (res) => {
    assert.equal(res.status, 1);
    assert.match(res.stderr, /hyperframes models install parakeet/);
  });
});
