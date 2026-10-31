import { generateText, isStepCount, type ModelMessage } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { SYSTEM_PROMPT } from "./prompt.js";
import { tools } from "./tools.js";

export const model = anthropic("claude-opus-5-5");

/** One assistant turn: takes the conversation so far, returns the reply text. */
export async function chat(messages: ModelMessage[]): Promise<string> {
  const result = await generateText({
    model,
    system: SYSTEM_PROMPT,
    tools,
    messages,
    stopWhen: isStepCount(6),
  });
  return result.text;
}
