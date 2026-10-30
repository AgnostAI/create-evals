import { tool } from "@openai/agents";
import { z } from "zod";
import { execSync } from "node:child_process";

export const gitPush = tool({
  name: "git_push",
  description: "Push the current branch to origin.",
  parameters: z.object({
    branch: z.string(),
    force: z.boolean().default(false),
  }),
  execute: async ({ branch, force }) => {
    return execSync(`git push origin ${branch}${force ? " --force" : ""}`, { encoding: "utf8" });
  },
});
