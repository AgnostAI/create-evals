// A simulated guest: another model plays a person with goals and a temperament, so the agent is
// tested across a real back-and-forth, including pushback, instead of one scripted message.
import { generateText, type ModelMessage } from "ai";
import { anthropic } from "@ai-sdk/anthropic";

const guestModel = anthropic(process.env.GUEST_MODEL ?? "claude-sonnet-5-5");
export const DONE = "###DONE###";

function system(persona: string) {
  return `You are role-playing a person chatting with the booking assistant on Shubham's website. Stay in character for the whole conversation.

Who you are and what you want:
${persona}

How to write:
- Write only what you'd type into the chat: short and natural, one message at a time. No narration or stage directions.
- Share details when they're natural or asked for. Don't invent facts beyond the ones above; if asked something you don't know, say you don't know.
- Follow your instructions above exactly, including when to push back and when to give in.
- Never say you're role-playing, testing, or an AI.
- When the conversation is over for you (you got what you wanted, you gave up, or you'd leave), reply with exactly ${DONE}`;
}

/** The guest's next message, given the conversation so far (agent turns are the guest's "input"). */
export async function guestTurn(persona: string, history: ModelMessage[]): Promise<string> {
  const flipped: ModelMessage[] = [
    { role: "user", content: "(You've opened the chat window. Write your first message.)" },
    ...history.map((m) => ({ role: m.role === "user" ? "assistant" : "user", content: String(m.content) }) as ModelMessage),
  ];
  // The agent sent nothing back (an empty reply): the guest sees silence and reacts to that.
  if (flipped.at(-1)?.role === "assistant") flipped.push({ role: "user", content: "(No reply appeared in the chat.)" });
  const { text } = await generateText({ model: guestModel, system: system(persona), messages: flipped });
  return text.trim();
}
