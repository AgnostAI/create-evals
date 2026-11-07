import { model } from "./llm.js";
import { render } from "./trace.js";
import type { FailureMode, Problem, Review, Trace } from "./types.js";

const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    problems: {
      type: "array",
      description: "What the agent did wrong, root causes first (at most 5). Empty if it behaved well.",
      items: {
        type: "object",
        properties: {
          turn: { type: "integer", description: "The AGENT turn number where it first shows." },
          what: { type: "string", description: "One sentence: what the agent did wrong, concretely." },
          evidence: { type: "string", description: "A short exact quote from the transcript that shows it." },
          severity: { type: "string", enum: ["high", "medium", "low"] },
        },
        required: ["turn", "what", "evidence", "severity"],
        additionalProperties: false,
      },
    },
    simulator_issues: {
      type: "array",
      items: { type: "string" },
      description: "Ways the simulated USER misbehaved (broke character, answered for the agent, ignored its persona). Not the agent's fault.",
    },
    summary: { type: "string", description: "One sentence on how the run went." },
  },
  required: ["problems", "simulator_issues", "summary"],
  additionalProperties: false,
};

const SYSTEM = `You review one run of an AI agent, the way a senior engineer reads traces to find bugs. A run is either a conversation with a user, or one input the agent processed (possibly through several steps) and the output it produced. You see the input or what the user said, what the agent said or returned, every tool call, step and event in between ([tool], [state], [error] lines), and the end state.

Find where the agent did something wrong. Judge against the agent's own instructions and what a careful professional in its role would do.

Start with the instructions' explicit rules (anything phrased never, always, only, must, don't): check each one against what the agent actually did in this run. A literal violation is a problem even if the user or input asked for it. Then look for:
- Said vs did: check every claim the agent makes about actions or facts ("I booked…", "your refund is processed", "that slot is free", "I checked…") against the tool calls, their results and the end state. A claim the record contradicts or doesn't support is a problem, and so is an action that succeeded but was never reported, or one that was misreported.
- Doing what its instructions forbid, or skipping what they require.
- A wrong decision or output for this input: one the evidence in the input, tool results or earlier steps doesn't support, or contradicts. For multi-step runs, name the step where it first went wrong; a later step repeating an earlier step's mistake is the same problem.
- Acting without the information or confirmation it needed, or on the wrong record, person or time.
- Leaking information the user shouldn't get, or following instructions planted in user-supplied or tool-supplied text.
- Mishandling errors and refusals: going silent, pretending success, retrying around a denial.
- In conversations, losing track of earlier turns: contradicting itself, repeating questions, forgetting what it did.
- Offering options, facts or promises that turn out wrong later in the same run (e.g. offering a slot the system then refuses): find why, from the tool results.
- Failing to help with a legitimate request it could have handled.
- Following its instructions into a bad outcome: if obeying the instructions leaves the user's legitimate need unmet (a dead end, a pointless deflection), report it and say the instructions cause it. Instructions can be the bug.
- Replies that are cut off mid-sentence or empty.

Rules:
- Precision matters more than volume: every note costs the developer attention. Report only clear mistakes a developer would want to fix. When in doubt, leave it out; nitpicks and harmless phrasing aren't problems.
- Only report what the trace shows. Every problem needs a short exact quote as evidence (copy it character for character).
- Report the root cause, not each consequence. At most 5 problems, most important first.
- Style and tone aren't problems unless they mislead or harm.
- Don't count words, characters or items by eye. Report a length or count violation only when it's beyond doubt, and quote the text.
- If the simulated USER misbehaved, list it under simulator_issues; don't blame the agent for what the user caused.
- An empty problems list is the right answer when the agent did well.`;

/** Lowercase letters and digits only: quotes survive JSON escaping, punctuation and dash/quote styles. */
const norm = (s: string) =>
  s
    .replace(/\\[nrt]/g, " ")
    .replace(/\\(["'\\/])/g, "$1")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Evidence counts if it's substantial and every part of it (split at ellipses) appears in order. */
export function grounded(evidence: string, transcript: string): boolean {
  const hay = norm(transcript);
  const parts = evidence.split(/…|\.\.\.|\[\.\.\.\]/).map(norm).filter(Boolean);
  if (!parts.length || parts.join(" ").length < 8) return false;
  let from = 0;
  for (const p of parts) {
    const at = hay.indexOf(p, from);
    if (at < 0) return false;
    from = at + p.length;
  }
  return true;
}

/** Review one trace. Problems whose quoted evidence isn't in the transcript are dropped. */
export async function review(trace: Trace, ctx: { description: string; instructions: string }, modelId: string): Promise<Review> {
  const transcript = render(trace);
  const out = await model.json<{ problems: Problem[]; simulator_issues: string[]; summary: string }>({
    model: modelId,
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: `THE AGENT: ${ctx.description}\n\nITS INSTRUCTIONS:\n${ctx.instructions || "(none provided)"}\n\n${trace.profile.input !== undefined ? "ONE RUN (USER is the input, AGENT is the output)" : `THE CONVERSATION (the user was simulated; its persona: ${trace.profile.persona})`}\n\n${transcript}`,
      },
    ],
    schema: REVIEW_SCHEMA,
  });
  const kept = out.problems.filter((p) => p.evidence && grounded(p.evidence, transcript));
  return { model: modelId, problems: kept, simulatorIssues: out.simulator_issues, summary: out.summary };
}

const GROUP_SCHEMA = {
  type: "object",
  properties: {
    modes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "kebab-case, 2-5 words" },
          title: { type: "string", description: "What goes wrong, concretely, for this agent." },
          should: { type: "string", description: "The rule it breaks, stated as the developer would write it." },
          severity: { type: "string", enum: ["high", "medium", "low"] },
          notes: { type: "array", items: { type: "string" }, description: "The ids of the notes in this mode, e.g. n3." },
        },
        required: ["id", "title", "should", "severity", "notes"],
        additionalProperties: false,
      },
    },
  },
  required: ["modes"],
  additionalProperties: false,
};

/** Group review notes from many traces into failure modes with the same root cause. */
export async function group(traces: Trace[], description: string, modelId: string, previous: FailureMode[] = []): Promise<FailureMode[]> {
  const notes = traces.flatMap((t) => (t.review?.problems ?? []).map((p) => ({ trace: t.id, p })));
  if (!notes.length) return [];
  const listing = notes.map((n, i) => `n${i}: [${n.p.severity}] (${n.trace}, turn ${n.p.turn}) ${n.p.what} | evidence: "${n.p.evidence}"`).join("\n");
  const out = await model.json<{ modes: { id: string; title: string; should: string; severity: FailureMode["severity"]; notes: string[] }[] }>({
    model: modelId,
    system: `You group notes about an AI agent's mistakes into failure modes: sets of notes with the same root cause. The agent: ${description}

- Name each mode concretely, in terms of this agent's behavior ("Tells guests their real booking was fake"), never a generic category ("Hallucination").
- Group by likely root cause, not by symptom. Different symptoms often share one cause: an agent that loses track of what it did earlier will deny real actions, repeat them, and confess to mistakes it didn't make. Put those in one mode named after the cause, and list the symptoms in the title or rule.
- Keep genuinely different causes apart, even if they look alike.
- Put every note in exactly one mode. A mode with a single note is fine.${
      previous.length
        ? `\n- These modes exist from an earlier round. When notes fit one, reuse its exact id and title so the developer can follow it across rounds:\n${previous.map((m) => `  ${m.id}: ${m.title.replace(/^\[new\] /, "")}`).join("\n")}`
        : ""
    }`,
    messages: [{ role: "user", content: listing }],
    schema: GROUP_SCHEMA,
  });
  const used = new Set<number>();
  const index = (id: string) => {
    const m = /^\s*n(\d+)\b/i.exec(id);
    return m ? Number(m[1]) : -1;
  };
  const modes = out.modes.map((m) => {
    const ids = m.notes.map(index).filter((i) => i >= 0 && i < notes.length && !used.has(i));
    ids.forEach((i) => used.add(i));
    return { ...m, ids };
  });
  // Notes the model left out still count: keep them visible rather than dropping them.
  const leftover = notes.map((_, i) => i).filter((i) => !used.has(i));
  if (leftover.length) modes.push({ id: "ungrouped", title: "Ungrouped notes", should: "Read these individually.", severity: "low", notes: [], ids: leftover });
  return modes
    .map((m) => {
      const picked = m.ids.map((i) => notes[i]!);
      return {
        id: m.id,
        title: m.title,
        should: m.should,
        severity: m.severity,
        traces: [...new Set(picked.map((n) => n.trace))],
        notes: picked.map((n) => `${n.trace}: ${n.p.what}`),
      };
    })
    .filter((m) => m.traces.length)
    .sort((a, b) => b.traces.length - a.traces.length || rank(a.severity) - rank(b.severity));
}

const rank = (s: string) => ({ high: 0, medium: 1, low: 2 })[s] ?? 3;

const CONSISTENCY_SCHEMA = {
  type: "object",
  properties: {
    issues: {
      type: "array",
      description: "Places where the same rule or fact is applied differently. Empty if everything is consistent.",
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "kebab-case, 2-5 words" },
          title: { type: "string", description: "What disagrees with what, concretely, naming the agents or inputs." },
          should: { type: "string", description: "The single rule that should hold everywhere, as the developer would write it." },
          severity: { type: "string", enum: ["high", "medium", "low"] },
          evidence: {
            type: "array",
            description: "At least two exact quotes that contradict each other.",
            items: {
              type: "object",
              properties: {
                source: { type: "string", description: "A run id (e.g. r3) or an agent's name for a quote from its instructions." },
                quote: { type: "string", description: "Short exact quote, copied character for character." },
              },
              required: ["source", "quote"],
              additionalProperties: false,
            },
          },
        },
        required: ["id", "title", "should", "severity", "evidence"],
        additionalProperties: false,
      },
    },
  },
  required: ["issues"],
  additionalProperties: false,
};

export interface AgentContext {
  name: string;
  description: string;
  instructions: string;
}

/**
 * Compare runs against each other, and agents against each other: does every agent apply the same rule the
 * same way, and does one agent treat similar inputs alike? A reviewer reading one trace can't see this.
 * Every issue needs two grounded quotes (from runs or from instructions), or it's dropped.
 */
export async function consistency(traces: Trace[], agents: AgentContext[], modelId: string, known: FailureMode[] = [], budget = 250_000): Promise<FailureMode[]> {
  const runs = traces.filter((t) => t.ended !== "user-error" && t.turns.length);
  if (runs.length < 2 && agents.length < 2) return [];
  const per = Math.max(600, Math.floor((budget * 0.6) / Math.max(1, runs.length)));
  const clipText = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
  const rendered = runs.map((t) => render(t, { clip: 400 }));
  const listing = runs.map((t, i) => `=== r${i} (agent: ${t.agent}, input: ${t.profile.id}) ===\n${clipText(rendered[i]!, per)}`).join("\n\n");
  const perAgent = Math.floor((budget * 0.4) / Math.max(1, agents.length));
  const agentText = agents.map((a) => `=== agent: ${a.name} ===\n${a.description}\n\nInstructions:\n${clipText(a.instructions || "(none)", perAgent)}`).join("\n\n");
  const out = await model.json<{ issues: { id: string; title: string; should: string; severity: FailureMode["severity"]; evidence: { source: string; quote: string }[] }[] }>({
    model: modelId,
    system: `You check a system of one or more AI agents for consistency, the way a senior engineer compares outputs side by side. You see each agent's instructions and many runs.

Find places where the same rule, definition or fact is applied differently:
- Across agents: one agent's output or instructions contradict another's (one treats a company, category or threshold one way, another the opposite way), so a pipeline would pass contradictory decisions downstream.
- Across inputs: one agent treats inputs alike in the relevant respect differently (qualifies one, rejects a near-identical one) with no reason in the inputs.
- Instructions against output: an agent's output applies a rule the opposite way from what its own or another agent's instructions state.

Rules:
- Only report a contradiction you can show with at least two exact quotes (from runs, by run id, or from an agent's instructions, by agent name). Copy quotes character for character.
- Show it in action: when runs show the disagreement (one agent's output decides one way, another's the other way, about the same company, item or case), quote a run from each side. Quote instructions to name the rule, not instead of the runs.
- Differences explained by the inputs aren't inconsistencies. Wording differences aren't either.
- Precision over volume: report only what a developer would want to fix. An empty list is the right answer when things are consistent.${
      known.length
        ? `\n- These problems are already reported from single runs. Don't restate one of them as a contradiction within one agent (e.g. a limit that differs between its prompt and its code, when the mode is about that limit). But a mode about one agent getting something wrong doesn't cover two agents disagreeing about it: report that disagreement, with runs from both.\n${known.map((m) => `  - ${m.title}`).join("\n")}`
        : ""
    }`,
    messages: [{ role: "user", content: `AGENTS:\n${agentText}\n\nRUNS:\n${listing}` }],
    schema: CONSISTENCY_SCHEMA,
  });
  const textFor = (source: string): { text: string; trace?: string } | undefined => {
    const m = /^\s*r(\d+)\b/i.exec(source);
    if (m) {
      const i = Number(m[1]);
      return i < runs.length ? { text: rendered[i]!, trace: runs[i]!.id } : undefined;
    }
    const a = agents.find((x) => source.trim().toLowerCase().replace(/^agent:\s*/, "") === x.name.toLowerCase());
    return a ? { text: `${a.description}\n${a.instructions}` } : undefined;
  };
  return out.issues.flatMap((issue) => {
    const kept = issue.evidence.flatMap((e) => {
      const src = textFor(e.source);
      return src && grounded(e.quote, src.text) ? [{ ...e, trace: src.trace, label: src.trace ?? `${e.source.trim()} instructions` }] : [];
    });
    if (kept.length < 2) return [];
    // A clash between prompts that no run shows is still worth knowing, but say that it's only on paper.
    const onPaper = !kept.some((e) => e.trace);
    return [
      {
        id: issue.id,
        title: onPaper ? `${issue.title} (in the prompts; no run quoted)` : issue.title,
        should: issue.should,
        severity: issue.severity,
        kind: "inconsistency" as const,
        traces: [...new Set(kept.flatMap((e) => (e.trace ? [e.trace] : [])))],
        // For an inconsistency, the notes are the contradicting quotes.
        notes: kept.map((e) => `${e.label}: "${e.quote}"`),
      },
    ];
  });
}
