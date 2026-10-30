import Anthropic from "@anthropic-ai/sdk";
import { TRIAGE_PROMPT } from "./prompts.js";
import type { Customer, Ticket, Triage } from "./types.js";

const client = new Anthropic();

export async function triageTicket(ticket: Ticket, customer: Customer, allowedTags: string[]): Promise<Triage> {
  const response = await client.beta.messages.create({
    model: "claude-opus-5-5",
    max_tokens: 16000,
    // On a policy decline, the API retries on a fallback model inside the same call.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: TRIAGE_PROMPT,
    messages: [
      {
        role: "user",
        content: `Allowed tags: ${allowedTags.join(", ")}
Customer plan: ${customer.plan} (LTV $${customer.lifetimeValueUsd}, ${customer.openTickets} open tickets)

Subject: ${ticket.subject}
Channel: ${ticket.channel}
Body:
${ticket.body}`,
      },
    ],
  });

  if (response.stop_reason === "refusal") throw new Error("Triage was declined by the model");
  const text = response.content.find((b) => b.type === "text")?.text ?? "{}";
  const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  const triage = JSON.parse(json) as Triage;
  if (triage.reply.length > 1200) triage.reply = triage.reply.slice(0, 1200);
  return triage;
}
