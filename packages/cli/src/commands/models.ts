import { defineCommand } from "citty";
import * as clack from "@clack/prompts";
import type { Example } from "./_examples.js";
import { c } from "../ui/colors.js";
import { formatBytes } from "../ui/format.js";
import { failCommand } from "../utils/commandResult.js";
import { PARAKEET_MODEL_LABEL } from "../whisper/parakeet.js";

export const examples: Example[] = [
  [
    "Download the Parakeet speech model that transcribe uses",
    "hyperframes models install parakeet",
  ],
];

function fail(message: string, json: boolean): never {
  if (json) console.log(JSON.stringify({ ok: false, error: message }));
  else console.error(c.error(message));
  failCommand();
}

async function installParakeet(json: boolean): Promise<void> {
  const sherpa = await import("../whisper/sherpa.js");
  const unsupported = sherpa.sherpaUnsupportedReason();
  if (unsupported) fail(unsupported, json);

  const spin = json ? null : clack.spinner({ output: process.stderr });
  spin?.start("Checking the sherpa-onnx runtime...");
  try {
    const runtimeMissing = !sherpa.sherpaRuntimeInstalled();
    if (runtimeMissing) {
      spin?.message("Installing the sherpa-onnx runtime from npm...");
      await sherpa.installSherpaRuntime();
    }
    spin?.message("Verifying the Parakeet model...");
    let lastPct = -1;
    const modelFetched = await sherpa.ensureParakeetModel({
      onBytes: (done, total) => {
        const pct = Math.floor((done / total) * 100);
        if (pct <= lastPct) return;
        lastPct = pct;
        spin?.message(
          `Downloading Parakeet TDT 0.6B v3 — ${c.progress(pct + "%")} ${c.dim("(" + formatBytes(done) + " / " + formatBytes(total) + ")")}`,
        );
      },
    });
    const changed = runtimeMissing || modelFetched;
    if (json) {
      console.log(
        JSON.stringify({
          ok: true,
          model: PARAKEET_MODEL_LABEL,
          changed,
          runtimeDir: sherpa.SHERPA_RUNTIME_DIR,
          modelDir: sherpa.PARAKEET_MODEL_DIR,
        }),
      );
    } else {
      spin?.stop(c.success(changed ? "Parakeet installed" : "Parakeet is already installed"));
    }
  } catch (err) {
    spin?.stop(c.error("Parakeet install failed"));
    fail(err instanceof Error ? err.message : String(err), json);
  }
}

export default defineCommand({
  meta: { name: "models", description: "Download on-device models (models install parakeet)" },
  args: {
    action: { type: "positional", description: "install", required: true },
    name: { type: "positional", description: "Model to install: parakeet", required: true },
    json: { type: "boolean", description: "Print one JSON result, no progress", default: false },
  },
  async run({ args }) {
    if (args.action !== "install" || args.name !== "parakeet") {
      fail(
        `Unknown: models ${args.action} ${args.name}. Try: hyperframes models install parakeet`,
        args.json,
      );
    }
    return installParakeet(args.json);
  },
});
