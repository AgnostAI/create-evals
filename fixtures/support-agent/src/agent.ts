import { generateText, isStepCount, type ModelMessage } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { SUPPORT_SYSTEM_PROMPT } from "./prompts.js";
import { tools } from "./tools/index.js";

export const model = anthropic("claude-opus-5-5");

export async function handleMessage(messages: ModelMessage[]) {
  const result = await generateText({
    model,
    system: SUPPORT_SYSTEM_PROMPT,
    tools,
    messages,
    stopWhen: isStepCount(8),
  });
  return result.text;
}
