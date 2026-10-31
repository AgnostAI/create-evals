import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["evals/**/*.eval.ts"],
    // The evals pin the owner's settings so results don't depend on who runs them.
    env: { OWNER_NAME: "Shubham", OWNER_TIMEZONE: "Asia/Kolkata" },
    testTimeout: 900_000,
    maxConcurrency: 7,
  },
});
