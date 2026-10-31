import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { AgentModel, ArgMatcher, Assertion as AssertionT, EvalSpec, SourceLoc } from "../core/types.js";
import { Assertion, Message, slugify, validateSpec } from "../evals/spec.js";

// Examples are how the developer says what their agent should do. The host agent writes a
// situation that forces a decision, lists the 2–4 things the agent could do, runs the real agent
// on it (`probe`), and the developer picks the right behavior. Each pick becomes a test.

const Option = z.object({
  id: z.string().regex(/^[a-z]$/).describe("a, b, c, d"),
  label: z.string().min(3).max(140).describe("What the agent does, in plain words: 'Asks the guest to confirm before booking'"),
  expect: z.array(Assertion).min(1).describe("Checks that tell this behavior apart from the other options"),
});

export const ExampleSchema = z.object({
  id: z.string().min(1),
  rule: z.string().min(3).max(80).describe("The evals.md heading this example falls under, e.g. 'Waits for a yes before booking'"),
  source: z.object({ file: z.string(), line: z.number().int().positive() }).optional().describe("The code or prompt line this situation comes from"),
  situation: z.string().min(3).max(160).describe("One line of context shown to the developer"),
  messages: z.array(Message).min(1).optional(),
  agent: z.string().optional(),
  args: z.array(z.any()).optional(),
  toolOutputs: z.record(z.string(), z.any()).optional(),
  toolRoutes: z.record(z.string(), z.array(z.object({ inputContains: z.string().min(1), output: z.any() }))).optional(),
  options: z.array(Option).min(2).max(4),
  expected: z.string().optional().describe("The option id the developer picked"),
  repeat: z
    .object({ runs: z.number().int().min(2).max(10), atLeast: z.number().int().min(1) })
    .refine((r) => r.atLeast <= r.runs, "atLeast can't exceed runs")
    .optional(),
});

export const ExamplesFileSchema = z.object({ examples: z.array(ExampleSchema).min(1) });
export type Example = z.infer<typeof ExampleSchema>;

export const EXAMPLES_PATH = ".create-evals/examples.json";

export function isExamplesFile(data: unknown): boolean {
  return !!data && typeof data === "object" && "examples" in data;
}

/** Problems with the examples, checked against the agent map and the real files. */
export function validateExamples(root: string, examples: Example[], model: AgentModel): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const ex of examples) {
    const where = ex.id;
    if (ids.has(ex.id)) problems.push(`${where}: duplicate id`);
    ids.add(ex.id);
    if (ex.source && !lineExists(root, ex.source)) problems.push(`${where}: source ${ex.source.file}:${ex.source.line} doesn't exist`);
    const optionIds = ex.options.map((o) => o.id);
    if (new Set(optionIds).size !== optionIds.length) problems.push(`${where}: option ids must be unique`);
    const labels = ex.options.map((o) => o.label.toLowerCase());
    if (new Set(labels).size !== labels.length) problems.push(`${where}: two options have the same label`);
    if (ex.expected && !optionIds.includes(ex.expected)) problems.push(`${where}: expected "${ex.expected}" isn't one of the options (${optionIds.join(", ")})`);
    if (sameChecks(ex.options)) problems.push(`${where}: two options have identical checks, so a run can't tell them apart`);
    // Each option must be a valid test on its own: reuse the spec validator for tools, params, args.
    for (const o of ex.options) {
      for (const p of validateSpec(toSpec([{ ...ex, expected: o.id }])[0]!, model)) problems.push(`${where} option ${o.id}: ${p}`);
    }
  }
  return problems;
}

function lineExists(root: string, loc: SourceLoc): boolean {
  const file = path.join(root, loc.file);
  return existsSync(file) && readFileSync(file, "utf8").split("\n").length >= loc.line;
}

function sameChecks(options: Example["options"]): boolean {
  const keys = options.map((o) => JSON.stringify(o.expect));
  return new Set(keys).size !== keys.length;
}

// ---------------------------------------------------------------------------
// Matching a real run against the options

export interface ProbeRun {
  id: string;
  text?: string;
  calls?: { tool: string; input: Record<string, unknown>; output?: unknown }[];
  output?: unknown;
  transcript?: string;
  error?: string;
}

/** pass / fail on deterministic checks; `judge` when only reading the reply can tell. */
export type CheckResult = "pass" | "fail" | "judge";

export function checkAssertion(run: ProbeRun, a: AssertionT): CheckResult {
  const calls = (run.calls ?? []).filter((c) => "tool" in a && c.tool === a.tool);
  switch (a.type) {
    case "not_called":
      return calls.some((c) => matches(c.input, a.with)) ? "fail" : "pass";
    case "called":
      return calls.some((c) => matches(c.input, a.with)) ? "pass" : "fail";
    case "max_calls":
      return calls.length <= a.max ? "pass" : "fail";
    case "every_call":
      return calls.every((c) => matches(c.input, a.with)) ? "pass" : "fail";
    case "not_contains":
      return (run.text ?? "").toLowerCase().includes(a.text.toLowerCase()) ? "fail" : "pass";
    default:
      return "judge";
  }
}

function matches(input: Record<string, unknown>, w: Record<string, ArgMatcher> | undefined): boolean {
  if (!w) return true;
  return Object.entries(w).every(([k, m]) => {
    const v = input?.[k] as unknown;
    if (m.eq !== undefined && v !== m.eq) return false;
    if (m.ne !== undefined && v === m.ne) return false;
    if (m.lte !== undefined && !(Number(v) <= m.lte)) return false;
    if (m.gte !== undefined && !(Number(v) >= m.gte)) return false;
    if (m.contains !== undefined && !String(v).includes(m.contains)) return false;
    if (m.notContains !== undefined && String(v ?? "").includes(m.notContains)) return false;
    if (m.absent !== undefined && m.absent !== !v) return false;
    return true;
  });
}

export interface OptionVerdict {
  id: string;
  label: string;
  /** fail = a deterministic check ruled it out; pass = all checks passed; judge = checks passed except ones only the reply can settle. */
  result: CheckResult;
  failed: string[];
}

export function matchOptions(ex: Example, run: ProbeRun): OptionVerdict[] {
  return ex.options.map((o) => {
    const results = o.expect.map((a) => ({ a, r: run.error ? ("fail" as const) : checkAssertion(run, a) }));
    const failed = results.filter((x) => x.r === "fail").map((x) => describe(x.a));
    const result: CheckResult = failed.length ? "fail" : results.some((x) => x.r === "judge") ? "judge" : "pass";
    return { id: o.id, label: o.label, result, failed };
  });
}

export function describe(a: AssertionT): string {
  const w = "with" in a && a.with ? ` with ${JSON.stringify(a.with)}` : "";
  switch (a.type) {
    case "not_called":
      return `doesn't call ${a.tool}${w}`;
    case "called":
      return `calls ${a.tool}${w}`;
    case "max_calls":
      return `calls ${a.tool} at most ${a.max}×`;
    case "every_call":
      return `every ${a.tool} call${w}`;
    case "not_contains":
      return `reply doesn't contain "${a.text}"`;
    case "judge":
      return `judge: ${a.criterion}`;
    case "output":
      return `output ${a.path} ${JSON.stringify(a.match)}`;
  }
}

// ---------------------------------------------------------------------------
// Picks → tests and evals.md

/** One spec per rule; each picked example is a case asserting the behavior the developer chose. */
export function toSpec(examples: Example[]): EvalSpec[] {
  const byRule = new Map<string, Example[]>();
  for (const ex of examples) {
    if (!ex.expected) continue;
    byRule.set(ex.rule, [...(byRule.get(ex.rule) ?? []), ex]);
  }
  return [...byRule].map(([rule, exs]) => {
    const first = exs[0]!;
    return {
      kind: "examples",
      questionId: first.id,
      agent: first.agent,
      slug: slugify(rule),
      title: rule,
      question: rule,
      answer: "yes",
      citation: first.source ?? { file: "evals.md", line: 1 },
      cases: exs.map((ex) => {
        const picked = ex.options.find((o) => o.id === ex.expected)!;
        return {
          name: `${ex.situation} → ${lowerFirst(picked.label)}`,
          control: false,
          messages: ex.messages,
          args: ex.args,
          toolOutputs: ex.toolOutputs,
          toolRoutes: ex.toolRoutes,
          expect: picked.expect,
          repeat: ex.repeat,
        };
      }),
    } satisfies EvalSpec;
  });
}

const lowerFirst = (s: string) => (/^[A-Z][a-z]/.test(s) ? s[0]!.toLowerCase() + s.slice(1) : s);

/** The readable record of what the agent should do: one heading per rule, one line per example. */
export function renderEvalsMd(examples: Example[], model: AgentModel): string {
  const picked = examples.filter((e) => e.expected);
  const rules = [...new Set(picked.map((e) => e.rule))];
  const lines = [
    "# Evals",
    "",
    `What ${path.basename(model.root)} should do, as examples. Each example is a test in this folder: create-evals ran your agent on it, and you picked the right behavior.`,
    "",
  ];
  for (const rule of rules) {
    const exs = picked.filter((e) => e.rule === rule);
    lines.push(`## ${rule}`, "");
    const sources = [...new Set(exs.filter((e) => e.source).map((e) => `\`${e.source!.file}:${e.source!.line}\``))];
    if (sources.length) lines.push(`Source: ${sources.join(", ")}`, "");
    for (const ex of exs) {
      const o = ex.options.find((x) => x.id === ex.expected)!;
      lines.push(`- ${inputLine(ex)} → ${lowerFirst(o.label)}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/** "Situation: "what the user said"", so each line reads on its own, even mid-conversation. */
function inputLine(ex: Example): string {
  const input = ex.args ? `\`${clip(JSON.stringify(ex.args), 80)}\`` : `"${clip((ex.messages?.at(-1)?.content ?? "").replace(/\s+/g, " "), 80)}"`;
  return `${ex.situation}: ${input}`;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
