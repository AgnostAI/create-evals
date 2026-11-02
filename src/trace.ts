import type { Trace, TraceEvent } from "./types.js";

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const show = (v: unknown, n = 600) => (v === undefined ? "" : clip(typeof v === "string" ? v : JSON.stringify(v), n));

function event(e: TraceEvent, n: number): string {
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
