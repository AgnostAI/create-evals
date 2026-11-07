import type { Trace, TraceEvent } from "./types.js";

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const show = (v: unknown, n = 600) => (v === undefined ? "" : clip(typeof v === "string" ? v : JSON.stringify(v), n));

/** One model call: what it wrote, the tools it called, and how it stopped when that matters. */
function modelCall(e: TraceEvent, n: number): string {
  const out = (e.output ?? {}) as { text?: string; tools?: { name: string; input: unknown }[]; stop?: string };
  const parts = [out.text?.trim() ? `wrote ${JSON.stringify(clip(out.text.trim(), n))}` : "wrote no text"];
  if (out.tools?.length) parts.push(`called ${out.tools.map((t) => `${t.name}(${show(t.input, Math.min(n, 300))})`).join(", ")}`);
  if (out.stop && !/^(end_turn|stop|tool_use|tool_calls|completed)$/.test(out.stop)) parts.push(`stopped: ${out.stop}`);
  const msgs = (e.input as { messages?: number } | undefined)?.messages;
  return `    [model] ${e.name}${msgs !== undefined ? ` (${msgs} messages in)` : ""}: ${parts.join("; ")}`;
}

function event(e: TraceEvent, n: number): string {
  if (e.kind === "model") return modelCall(e, n);
  const io = [e.input !== undefined ? show(e.input, n) : "", e.output !== undefined ? `→ ${show(e.output, n)}` : ""].filter(Boolean).join(" ");
  return `    [${e.kind}] ${e.name}${io ? ` ${io}` : ""}`;
}

/** The conversation with everything the agent did in between, as a reviewer or a failing test should see it. */
export function render(trace: Trace, opts: { state?: boolean; clip?: number } = {}): string {
  const n = opts.clip ?? 600;
  const lines: string[] = [];
  let agentTurn = 0;
  for (const t of trace.turns) {
    if (t.role === "user") {
      lines.push(`USER: ${t.text}`);
      continue;
    }
    for (const e of trace.events.filter((x) => x.turn === agentTurn)) lines.push(event(e, n));
    lines.push(`AGENT (turn ${agentTurn}): ${t.text.trim() ? t.text : "[empty reply]"}`);
    agentTurn++;
  }
  for (const e of trace.events.filter((x) => x.turn >= agentTurn)) lines.push(event(e, n));
  if (trace.error) lines.push(`[conversation ended: ${trace.error}]`);
  if (opts.state !== false && trace.state !== undefined) lines.push("", "END STATE:", show(trace.state, Math.max(n, 6000)));
  return lines.join("\n");
}
