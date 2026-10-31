import readline from "node:readline/promises";
import type { ModelMessage } from "ai";
import { chat } from "./agent.js";

// A tiny terminal chat for trying the agent by hand.
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const messages: ModelMessage[] = [];
console.log("Scheduling assistant for Priya. Ask about her calendar (Ctrl-C to quit).\n");
for (;;) {
  const text = await rl.question("you › ");
  if (!text.trim()) continue;
  messages.push({ role: "user", content: text });
  const reply = await chat(messages);
  messages.push({ role: "assistant", content: reply });
  console.log(`\nassistant › ${reply}\n`);
}
