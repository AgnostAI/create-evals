import { defineAgent } from "create-evals";
import type { ModelMessage } from "ai";
import { createAgent } from "../src/agent.js";
import { at, week } from "./seed.js";
import { World } from "./world.js";

export default defineAgent({
  name: "booking-agent",
  description:
    "A public chat page where anyone can book a meeting with Shubham. It checks his calendar's free/busy, offers open times in the guest's time zone, books Google Meet events (Google emails the invite), and reschedules or cancels with a booking code plus the guest's email.",
  instructions: ["src/prompt.ts", "src/tools.ts", "src/config.ts"],

  async start(ctx) {
    // The agent's real tools and rules run against an in-memory calendar instead of Google.
    const world = new World(week({ fullDay: ctx.profile.setup?.fullDay as string | undefined }), ctx.record);
    const agent = createAgent(world);
    const timeZone = (ctx.profile.setup?.timeZone as string) ?? "Asia/Kolkata";
    // Optional mid-conversation change: someone else takes a slot after the agent's Nth reply.
    const take = ctx.profile.setup?.takeSlot as { afterTurn: number; start: string; end: string } | undefined;
    const history: ModelMessage[] = []; // kept the way src/server.ts keeps it: every step, tool calls included
    let turn = 0;

    return {
      async send(message) {
        history.push({ role: "user", content: message });
        const reply = await agent.respond(history, timeZone);
        history.push(...reply.messages);
        for (const m of reply.messages) {
          if (m.role !== "assistant" && m.role !== "tool") continue;
          for (const part of typeof m.content === "string" ? [] : m.content) {
            if (part.type === "tool-call") ctx.record({ kind: "tool", name: part.toolName, input: part.input });
            if (part.type === "tool-result") ctx.record({ kind: "tool", name: `${part.toolName} result`, output: part.output });
          }
        }
        if (take && turn === take.afterTurn) world.block("Booked via another link", at(take.start), at(take.end));
        turn++;
        return reply.text;
      },
      state: () => world.snapshot(),
    };
  },
});
