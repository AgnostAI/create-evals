import { defineAgent } from "create-evals";
import { handle } from "../src/agent.js";
export default defineAgent({
  name: "mini",
  description: "test",
  start(ctx) {
    ctx.state.sent = [];
    return { send: (m) => handle(m), state: () => ({ sent: ctx.state.sent }) };
  },
});
