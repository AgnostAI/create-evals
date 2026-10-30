import { run } from "@openai/agents";
import { devbot } from "./agent.js";

const task = process.argv.slice(2).join(" ") || "Run the tests and fix whatever is failing.";
const result = await run(devbot, task);
console.log(result.finalOutput);
