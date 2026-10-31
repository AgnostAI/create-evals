import type { ModelMessage } from "ai";
import { generateText, Output } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { createAgent } from "../src/agent.js";
import { World } from "./world.js";
import { DONE, guestTurn } from "./guest.js";

export interface Scenario {
  world: World;
  /** Who the simulated guest is, what they want, and how they behave. */
  guest: string;
  /** The guest's browser time zone (what the web page sends). */
  guestTimeZone: string;
  now: Temporal.Instant;
  maxTurns?: number;
  /** Change the world after the agent's Nth reply (0-based), e.g. someone else takes a slot. */
  afterAgentTurn?: (turn: number, world: World) => void;
}

export interface Result {
  world: World;
  history: ModelMessage[];
  /** Everything the agent said, joined. */
  agentText: string;
  /** The conversation interleaved with calendar operations; printed when an assertion fails. */
  transcript: string;
}

/** What a person sees in the chat window: their messages and the agent's text, no tool traffic. */
function visible(history: ModelMessage[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const m of history) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    const text = typeof m.content === "string" ? m.content : m.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
    if (!text.trim()) continue;
    const last = out.at(-1);
    if (last && last.role === m.role) last.content = `${last.content}${text}`;
    else out.push({ role: m.role, content: text } as ModelMessage);
  }
  return out;
}

export async function converse(s: Scenario): Promise<Result> {
  const agent = createAgent(s.world, () => s.now);
  const history: ModelMessage[] = [];
  const lines: string[] = [];
  for (let turn = 0; turn < (s.maxTurns ?? 8); turn++) {
    const said = await guestTurn(s.guest, visible(history));
    if (said.includes(DONE) || !said) break;
    history.push({ role: "user", content: said });
    lines.push(`GUEST: ${said}`);
    const logStart = s.world.log.length;
    const { text: reply, messages } = await agent.respond(history, s.guestTimeZone);
    history.push(...messages);
    lines.push(...s.world.log.slice(logStart).map((l) => `  · ${l}`), `AGENT: ${reply.trim() || "[empty reply: nothing shown to the guest]"}`);
    const before = s.world.log.length;
    s.afterAgentTurn?.(turn, s.world);
    lines.push(...s.world.log.slice(before).map((l) => `  · ${l}`));
  }
  const agentText = visible(history).filter((m) => m.role === "assistant").map((m) => String(m.content)).join("\n");
  const end = s.world.bookings.map((b) => `  ${b.code} ${b.start} ${b.guestEmail} "${b.topic}"`).join("\n") || "  (none)";
  return { world: s.world, history, agentText, transcript: `${lines.join("\n")}\n\nBOOKINGS AT END:\n${end}` };
}

/** Does `text` state the time `t` as seen in `tz` (e.g. "1:00 PM", "1 PM", "13:00")? */
export function mentionsTime(text: string, t: Temporal.Instant, tz: string): boolean {
  const z = t.toZonedDateTimeISO(tz);
  const h12 = z.hour % 12 || 12;
  const ampm = z.hour < 12 ? "am" : "pm";
  const mm = String(z.minute).padStart(2, "0");
  const variants = [`${h12}:${mm}${ampm}`, `${String(z.hour).padStart(2, "0")}:${mm}`, `${z.hour}:${mm}`];
  if (z.minute === 0) variants.push(`${h12}${ampm}`);
  const norm = text.toLowerCase().replace(/\s+(am|pm)\b/g, "$1").replace(/\./g, "");
  return variants.some((v) => norm.includes(v));
}

const judgeModel = anthropic(process.env.JUDGE_MODEL ?? "claude-sonnet-5-5");

/** For the few things only the text can show. */
export async function judge(transcript: string, criterion: string): Promise<{ pass: boolean; reason: string }> {
  const { output } = await generateText({
    model: judgeModel,
    output: Output.object({ schema: z.object({ pass: z.boolean(), reason: z.string() }) }),
    system: "You grade one transcript of a booking assistant against one criterion. Judge only that criterion, from what the transcript shows. If it isn't clearly met, it fails.",
    prompt: `Criterion: ${criterion}\n\nTranscript:\n${transcript}`,
  });
  return output;
}
