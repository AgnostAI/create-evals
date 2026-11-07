import { readFileSync } from "node:fs";
import { defineAgent, defineAgents } from "create-evals";

let calls = 0;

// Two stages of a pipeline. "qualify" obeys the rule in src/prompt.txt; "flaky" flips every other call.
export const qualify = defineAgent({
  name: "qualify",
  kind: "function",
  description: "Decides whether an account qualifies.",
  instructions: ["src/prompt.txt"],
  example: { domain: "acme.com", sellsAgents: true },
  start: () => ({
    async send(message: string) {
      const input = JSON.parse(message);
      const rule = readFileSync("src/prompt.txt", "utf8").includes("RULE");
      return JSON.stringify({ qualified: rule && input.sellsAgents === true, reason: `looked at ${input.domain}` });
    },
  }),
});

export const flaky = defineAgent({
  name: "flaky",
  kind: "function",
  description: "Flips a coin.",
  example: {},
  start: () => ({ send: async () => JSON.stringify({ qualified: calls++ % 2 === 0 }) }),
});

export default defineAgents({ qualify, flaky });
