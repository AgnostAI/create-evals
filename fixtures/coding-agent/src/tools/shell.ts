import { tool } from "@openai/agents";
import { z } from "zod";
import { execSync } from "node:child_process";

export const runShell = tool({
  name: "run_shell",
  description: "Run a shell command in the repository and return stdout/stderr.",
  parameters: z.object({ command: z.string() }),
  execute: async ({ command }) => {
    return execSync(command, { cwd: process.cwd(), encoding: "utf8" });
  },
});
