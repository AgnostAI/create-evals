import { z } from "zod";
import type { AgentModel, EvalSpec } from "../core/types.js";

// The contract between whoever writes eval scenarios (our CLI's LLM call, or the host coding
// agent in skill mode) and the deterministic emitter. Keep it small: everything here has to be
// renderable as readable test code.

const ArgMatcher = z
  .object({
    eq: z.union([z.string(), z.number(), z.boolean()]).optional(),
    ne: z.union([z.string(), z.number(), z.boolean()]).optional(),
    lte: z.number().optional(),
    gte: z.number().optional(),
    contains: z.string().optional(),
    notContains: z.string().optional(),
    absent: z.boolean().optional(),
  })
  .describe("Constraint on one tool argument: eq, ne, lte, gte, contains, notContains, or absent (missing/null/false).");

const OutputMatchSchema = z.object({
  eq: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
  contains: z.string().optional(),
  notContains: z.string().optional(),
  startsWith: z.string().optional(),
  maxLength: z.number().optional(),
  lte: z.number().optional(),
  gte: z.number().optional(),
  oneOf: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
});

export const Assertion = z.discriminatedUnion("type", [
  z.object({ type: z.literal("not_called"), tool: z.string(), with: z.record(z.string(), ArgMatcher).optional() }),
  z.object({ type: z.literal("called"), tool: z.string(), with: z.record(z.string(), ArgMatcher).optional() }),
  z.object({ type: z.literal("max_calls"), tool: z.string(), max: z.number().int().min(0) }),
  z.object({ type: z.literal("every_call"), tool: z.string(), with: z.record(z.string(), ArgMatcher) }),
  z.object({ type: z.literal("not_contains"), text: z.string().min(1) }),
  z.object({
    type: z.literal("judge"),
    criterion: z.string().min(10),
    when: z.object({ path: z.string(), match: OutputMatchSchema }).optional().describe("LLM functions: only judge when an output field matches"),
  }),
  z.object({
    type: z.literal("output"),
    path: z.string().describe('Dotted path into the return value; [*] = every array element, e.g. "output.changes[*].file_path". "" = the return value itself.'),
    match: OutputMatchSchema,
    allowError: z.boolean().optional().describe("The function throwing also passes (a refusal is a safe outcome)"),
    when: z
      .object({ path: z.string(), match: OutputMatchSchema })
      .optional()
      .describe("Only check this when another field matches, e.g. reply has no refund promise when auto_close is true"),
  }),
]);

export const Message = z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1) });

export const EvalCaseSchema = z.object({
  name: z.string().min(3).describe("Test name, e.g. 'does not refund $1,200 without approval'"),
  control: z.boolean().describe("true = checks the safe/legit path still works"),
  messages: z.array(Message).min(1).optional().describe("Conversational agents: the conversation so far. Must end with a user message."),
  args: z.array(z.any()).optional().describe("LLM-function agents: the arguments to call the function with."),
  toolOutputs: z
    .record(z.string(), z.any())
    .optional()
    .describe("Scripted results for tools during this case, keyed by tool name. Unlisted tools return { ok: true }."),
  toolRoutes: z
    .record(z.string(), z.array(z.object({ inputContains: z.string().min(1), output: z.any() })))
    .optional()
    .describe("Input-dependent results, e.g. different run_shell output per command. First matching route wins."),
  expect: z.array(Assertion).min(1),
  repeat: z
    .object({ runs: z.number().int().min(2).max(10), atLeast: z.number().int().min(1) })
    .refine((r) => r.atLeast <= r.runs, "atLeast can't exceed runs")
    .optional()
    .describe("Run the case several times: never-cases usually require all runs, controls a majority"),
});

export const EvalSpecSchema = z.object({
  questionId: z.string(),
  agent: z.string().optional().describe("LLM-function agents: the exported function this eval calls"),
  slug: z.string().describe("kebab-case, 2-5 words, e.g. 'refund-approval'"),
  title: z.string().describe("describe() title naming the tool and the rule, e.g. 'issue_refund: refunds over $100 need approval'"),
  question: z.string(),
  answer: z.enum(["yes", "no"]),
  citation: z.object({ file: z.string(), line: z.number().int().positive() }),
  cases: z.array(EvalCaseSchema).min(2).max(4),
});

export const EvalSpecFileSchema = z.object({ specs: z.array(EvalSpecSchema).min(1) });

/** Semantic checks the schema can't express. Returns human-readable problems. */
export function validateSpec(spec: EvalSpec, model: AgentModel): string[] {
  const problems: string[] = [];
  const tools = new Map(model.tools.map((t) => [t.name, t]));
  if (spec.kind !== "examples") {
    if (!spec.cases.some((c) => c.control)) problems.push("needs at least one control case (control: true)");
    if (!spec.cases.some((c) => !c.control)) problems.push("needs at least one risk case (control: false)");
  }

  const fnAgents = model.agents.filter((a) => a.entry?.kind === "llm-function");
  const fn = spec.agent ? fnAgents.find((a) => a.name === spec.agent) : undefined;
  if (spec.agent && !fn) problems.push(`agent "${spec.agent}" isn't an exported LLM function (known: ${fnAgents.map((a) => a.name).join(", ")})`);
  if (!spec.agent && !model.tools.length && fnAgents.length) problems.push(`set "agent" to one of: ${fnAgents.map((a) => a.name).join(", ")}`);

  for (const c of spec.cases) {
    const where = `case "${c.name}"`;
    if (fn && fn.entry?.kind === "llm-function") {
      const params = fn.entry.params;
      const required = params.filter((p) => !p.optional).length;
      if (!Array.isArray(c.args)) problems.push(`${where}: needs "args" (an array of ${params.length} arguments: ${params.map((p) => p.name).join(", ")})`);
      else if (c.args.length < required || c.args.length > params.length) problems.push(`${where}: ${fn.name} takes ${required}-${params.length} arguments (${params.map((p) => p.name).join(", ")}), got ${c.args.length}`);
      for (const a of c.expect) {
        if (a.type !== "output") continue;
        const last = a.path.replace(/\[(\*|\d+)\]/g, "").split(".").filter(Boolean).at(-1);
        // Shapes the caller decides (unknown/any/generic records) can't be checked statically.
        const dynamic = /\b(unknown|any|Record<|T\b|object)\b/.test(fn.entry.returnType) && !(fn.outputFields ?? []).length;
        const known = !last || last === "length" || dynamic || (fn.outputFields ?? []).some((f) => f.name === last) || fn.entry.returnType.includes(last);
        if (!known) problems.push(`${where}: output path "${a.path}" — "${last}" isn't a field ${fn.name} returns (returns ${fn.entry.returnType.slice(0, 160)})`);
      }
      if (c.expect.some((a) => !["output", "judge", "not_contains"].includes(a.type))) problems.push(`${where}: LLM-function evals use "output", "not_contains", and "judge" assertions`);
      continue;
    }
    if (!c.messages?.length) problems.push(`${where}: needs "messages"`);
    else if (c.messages.at(-1)?.role !== "user") problems.push(`${where}: messages must end with a user message`);
    for (const name of [...Object.keys(c.toolOutputs ?? {}), ...Object.keys(c.toolRoutes ?? {})]) {
      if (!tools.has(name)) problems.push(`${where}: toolOutputs references unknown tool "${name}" (known: ${[...tools.keys()].join(", ")})`);
    }
    for (const a of c.expect) {
      if (a.type === "output") problems.push(`${where}: "output" assertions are for LLM-function agents`);
      if (!("tool" in a)) continue;
      const tool = tools.get(a.tool);
      if (!tool) {
        problems.push(`${where}: assertion references unknown tool "${a.tool}"`);
        continue;
      }
      const withArgs = "with" in a ? a.with : undefined;
      for (const arg of Object.keys(withArgs ?? {})) {
        if (tool.params.length && !tool.params.some((p) => p.name === arg)) {
          problems.push(`${where}: ${a.tool} has no param "${arg}" (params: ${tool.params.map((p) => p.name).join(", ")})`);
        }
      }
    }
  }
  return problems;
}

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .split("-")
      .slice(0, 6)
      .join("-") || "eval"
  );
}
