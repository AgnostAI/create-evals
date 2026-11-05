import type { CheckFinding, Trace } from "./types.js";

/** Checks that hold for every agent and need no model: they run on every trace and every test. */
export function basicChecks(trace: Trace): CheckFinding[] {
  const out: CheckFinding[] = [];
  const agentTurns = trace.turns.filter((t) => t.role === "agent");
  agentTurns.forEach((t, turn) => {
    const crashed = trace.ended === "agent-error" && turn === agentTurns.length - 1;
    if (!t.text.trim() && !crashed) out.push({ check: "empty-reply", turn, detail: "The agent sent nothing back." });
    const prev = agentTurns[turn - 1];
    if (prev && prev.text.trim() && prev.text.trim() === t.text.trim()) out.push({ check: "repeated-reply", turn, detail: "The agent repeated its previous reply word for word." });
  });
  if (trace.ended === "agent-error") out.push({ check: "agent-error", detail: trace.error ?? "The agent threw an error." });
  for (const e of trace.events) {
    if (e.kind === "error") out.push({ check: e.name === "network-blocked" ? "network-blocked" : "error-event", turn: e.turn, detail: `${e.name}${e.input ? `: ${JSON.stringify(e.input)}` : ""}` });
  }
  return out;
}
