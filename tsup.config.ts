import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts", "src/cli.ts", "src/hooks.ts", "src/project.ts", "src/context.ts"],
    format: ["esm"],
    target: "node22",
    platform: "node",
    clean: true,
    splitting: true,
    external: ["tsx"],
  },
  // The runtime as CommonJS, for bindings compiled as CommonJS (a repo without "type": "module", e.g. a Python
  // repo). Node 22 can't require() the ESM build while the CLI is loading it. The registry and the conversation
  // context live on globalThis, so both copies agree.
  {
    entry: { index: "src/index.ts" },
    format: ["cjs"],
    target: "node22",
    platform: "node",
    shims: true,
    splitting: false,
    external: ["tsx"],
  },
]);
