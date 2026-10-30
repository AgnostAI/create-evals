import { defineConfig } from "vitest/config";

// Real model calls: writes evals for each fixture and runs them. Needs ANTHROPIC_API_KEY.
export default defineConfig({
  test: {
    include: ["test/e2e/**/*.e2e.ts"],
    testTimeout: 900_000,
    fileParallelism: false,
  },
});
