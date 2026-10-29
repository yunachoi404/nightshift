import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Tests run against the contract's and the editor's source, so they need no build step.
    alias: {
      "@nightshift/contract": fileURLToPath(new URL("../contract/src/index.ts", import.meta.url)),
      "@nightshift/editor": fileURLToPath(new URL("../editor/src/index.ts", import.meta.url)),
    },
  },
  // Several files launch ffmpeg and Chrome. Bound file concurrency on shared development machines.
  test: { include: ["test/**/*.test.ts"], testTimeout: 30_000, maxWorkers: 4 },
});
