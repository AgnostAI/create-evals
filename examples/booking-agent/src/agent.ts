import { generateText, isStepCount, type ModelMessage } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import type { Calendar } from "./calendar.js";
import { config } from "./config.js";
import { googleCalendar } from "./google.js";
import { systemPrompt } from "./prompt.js";
import { createTools } from "./tools.js";

export const model = anthropic(process.env.MODEL ?? "claude-opus-5-5");

/** The booking agent over a calendar and a clock. Production: Google Calendar and the real time. */
export function createAgent(calendar: Calendar, clock: () => Temporal.Instant = () => Temporal.Now.instant()) {
  const tools = createTools(calendar, clock);
  return {
    tools,
    /**
     * One assistant turn. Returns the reply and the messages to append to the history, including
     * tool calls and results: keep all of them, or next turn the agent sees itself claiming things
     * (a booking, a checked slot) with no record of doing them.
     */
    async respond(history: ModelMessage[], guestTimeZone = config.timeZone): Promise<{ text: string; messages: ModelMessage[] }> {
      const result = await generateText({
        model,
        system: systemPrompt(guestTimeZone, clock()),
        tools,
        messages: history,
        stopWhen: isStepCount(8),
      });
      // `result.response.messages` holds only the last step; the tool calls and results live in
      // the earlier steps, and the agent needs those next turn to know what it actually did.
      const messages = withoutDanglingToolCalls(result.steps.flatMap((step) => step.response.messages));
      // The model can stop without a reply (e.g. a content filter mid-turn). Never leave the guest
      // facing silence, and keep the history valid so the next turn still works.
      if (!result.text.trim()) {
        const text = "Sorry, I couldn't handle that last message. Could you rephrase it? I can still help you find a time and book a meeting with " + config.ownerName + ".";
        return { text, messages: [...messages, { role: "assistant", content: text }] };
      }
      return { text: result.text, messages };
    },
  };
}

/** Drops tool calls that never got a result (a turn cut short), which would break every later turn. */
function withoutDanglingToolCalls(messages: ModelMessage[]): ModelMessage[] {
  const answered = new Set(messages.flatMap((m) => (m.role === "tool" ? m.content.flatMap((p) => ("toolCallId" in p ? [p.toolCallId] : [])) : [])));
  return messages.flatMap((m) => {
    if (m.role !== "assistant" || typeof m.content === "string") return [m];
    const content = m.content.filter((p) => p.type !== "tool-call" || answered.has(p.toolCallId));
    return content.length ? [{ ...m, content }] : [];
  });
}

export const agent = createAgent(googleCalendar);
