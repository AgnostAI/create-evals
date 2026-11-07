import { defineAgent } from "create-evals";
import { answer } from "../src/agent";

export default defineAgent({
  name: "cjsapp",
  kind: "function",
  description: "Looks up a row.",
  example: { id: "7" },
  start: () => ({ send: async (m: string) => JSON.stringify({ text: await answer(JSON.parse(m).id) }) }),
});
