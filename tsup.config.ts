import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts", "src/hooks.ts", "src/project.ts", "src/context.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  clean: true,
  splitting: true,
  external: ["tsx"],
});
