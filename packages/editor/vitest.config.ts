import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Tests run against the contract's source, so they need no build step.
    alias: { "@nightshift/contract": fileURLToPath(new URL("../contract/src/index.ts", import.meta.url)) },
  },
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
