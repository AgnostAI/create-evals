import { generateText, isStepCount, type ModelMessage } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { config } from "./config.js";
import { systemPrompt } from "./prompt.js";
import { tools } from "./tools.js";

export const model = anthropic(process.env.MODEL ?? "claude-opus-5-5");

/** One assistant turn: takes the conversation so far, returns the reply text. */
export async function chat(messages: ModelMessage[], guestTimeZone = config.timeZone): Promise<string> {
  const result = await generateText({
    model,
    system: systemPrompt(guestTimeZone),
    tools,
    messages,
    stopWhen: isStepCount(8),
  });
  return result.text;
}
