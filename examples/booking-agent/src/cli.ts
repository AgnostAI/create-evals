import readline from "node:readline/promises";
import type { ModelMessage } from "ai";
import { chat } from "./agent.js";
import { config } from "./config.js";

// Chat with the agent in a terminal, as a guest would on the web page.
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const messages: ModelMessage[] = [];
const timeZone = process.env.GUEST_TIMEZONE ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
console.log(`Book a meeting with ${config.ownerName}. You're a guest in ${timeZone} (Ctrl-C to quit).\n`);
for (;;) {
  const text = await rl.question("you › ");
  if (!text.trim()) continue;
  messages.push({ role: "user", content: text });
  const reply = await chat(messages, timeZone);
  messages.push({ role: "assistant", content: reply });
  console.log(`\nassistant › ${reply}\n`);
}
