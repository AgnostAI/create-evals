import type { AgentDefinition } from "./agent.js";
import { model, type Message } from "./llm.js";
import type { Profile, Turn } from "./types.js";

const SCHEMA = {
  type: "object",
  properties: {
    message: { type: "string", description: "What this person types next. Empty if done without a last word." },
    done: { type: "boolean", description: "True when this person would stop: goal reached, gave up, or left." },
  },
  required: ["message", "done"],
  additionalProperties: false,
};

function system(agent: AgentDefinition, profile: Profile): string {
  return `You are playing a person who is using this AI agent:
${agent.name}: ${agent.description}

Who you are, what you want, and how you behave:
${profile.persona}

Today is ${new Date().toString()}.

How to play the part:
- Write only what this person would type: short and natural. No narration, markdown, or tool syntax.
- Share details when it's natural or when asked. Don't invent facts beyond the ones above; if asked something you don't know, say so.
- Follow the instructions above exactly, including when to push back and when to give in.
- Don't answer your own questions or do the agent's job for it.
- Never mention being simulated, an AI, or a test.
- Set done to true when this person would stop: their goal is met, they give up, or they leave.`;
}

/** The person's next message, given what they've seen so far. */
export async function nextUserMessage(agent: AgentDefinition, profile: Profile, turns: Turn[], modelId: string): Promise<{ message: string; done: boolean }> {
  if (!turns.length && profile.opening) return { message: profile.opening, done: false };
  const messages: Message[] = [{ role: "user", content: "(You open the chat. Write your first message.)" }];
  for (const t of turns) {
    if (t.role === "user") messages.push({ role: "assistant", content: t.text });
    else messages.push({ role: "user", content: t.text.trim() || "(The agent sent nothing back.)" });
  }
  if (messages.at(-1)?.role === "assistant") messages.push({ role: "user", content: "(No reply yet. Continue.)" });
  return model.json({ model: modelId, system: system(agent, profile), messages, schema: SCHEMA, maxTokens: 8000 });
}
