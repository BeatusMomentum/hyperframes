import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Tests that run a real ffmpeg take well under a second, but a loaded Windows runner can stall one past vitest's
    // 5 s default; a hang still fails, at this ceiling.
    testTimeout: 60_000,
  },
});
