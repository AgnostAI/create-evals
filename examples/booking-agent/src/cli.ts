import readline from "node:readline/promises";
import type { ModelMessage } from "ai";
import { agent } from "./agent.js";
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
  const reply = await agent.respond(messages, timeZone);
  messages.push(...reply.messages);
  console.log(`\nassistant › ${reply.text}\n`);
}
