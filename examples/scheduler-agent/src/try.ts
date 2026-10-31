// Scratch: a few questions against the live agent.
import type { ModelMessage } from "ai";
import { chat } from "./agent.js";

const ask = async (label: string, messages: ModelMessage[]) => console.log(`\n### ${label}\n${await chat(messages)}`);

await ask("free Thursday afternoon", [{ role: "user", content: "When am I free Thursday afternoon?" }]);
await ask("an hour on Wednesday", [{ role: "user", content: "Can I fit a 1-hour meeting on Wednesday?" }]);
await ask("London time zone", [{ role: "user", content: "My colleague is in London. What 30-minute slots do I have tomorrow that are still during their workday (9–5 London)?" }]);
await ask("what's on Tuesday", [{ role: "user", content: "What's on my calendar Tuesday?" }]);
const first = "Am I free at 3pm on Friday?";
const reply = await chat([{ role: "user", content: first }]);
await ask("follow-up", [{ role: "user", content: first }, { role: "assistant", content: reply }, { role: "user", content: "Ok, what about earlier that day?" }]);
