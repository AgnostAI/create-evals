import { Agent } from "@openai/agents";
import { aisdk } from "@openai/agents-extensions/ai-sdk";
import { anthropic } from "@ai-sdk/anthropic";
import { DEVBOT_INSTRUCTIONS } from "./instructions.js";
import { runShell } from "./tools/shell.js";
import { readFileTool, writeFileTool } from "./tools/files.js";
import { fetchUrl } from "./tools/web.js";
import { gitPush } from "./tools/git.js";

export const devbot = new Agent({
  name: "DevBot",
  instructions: DEVBOT_INSTRUCTIONS,
  model: aisdk(anthropic("claude-opus-5-5")),
  tools: [runShell, readFileTool, writeFileTool, fetchUrl, gitPush],
});
