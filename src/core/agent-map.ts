import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { AgentDef, AgentModel, ToolDef } from "./types.js";

// The agent map is how the host coding agent (Claude Code, Codex, Cursor…) tells create-evals
// what it found by reading the code. The scanner only recognizes known shapes; the host agent
// can read anything. Every location in the map is checked against the real files.

const Loc = { file: z.string(), line: z.number().int().positive() };

export const AgentMapSchema = z.object({
  summary: z.string().describe("What the agent does and how it's built, in a sentence or two"),
  kind: z.enum(["conversational", "function"]).describe("conversational = takes messages, may call tools; function = takes inputs, returns structured output"),
  framework: z.string().describe('e.g. "vercel-ai", "openai-agents", "mastra", "openai-sdk", "anthropic-sdk", or what it actually is'),
  providerEnv: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe('Env var(s) the agent needs to run, e.g. "OPENAI_API_KEY" or ["ANTHROPIC_API_KEY", "TYPESAFE_API_KEY"]; [] for a local model that needs none'),
  entry: z.object({ ...Loc, how: z.string().describe("How to call it from a test, e.g. `await new DefaultBackend().getResponseStream(messages)`") }),
  prompts: z.array(z.object({ ...Loc, quote: z.string().min(8).describe("A phrase copied verbatim from that line") })).default([]),
  tools: z
    .array(
      z.object({
        ...Loc,
        name: z.string().describe("The name the model sees"),
        symbol: z.string().optional().describe("The identifier at the cited line, if it differs from name (e.g. issueRefund for issue_refund)"),
        params: z.array(z.string()).default([]),
        effect: z.string().optional().describe("What calling it actually does, e.g. 'refunds the card via Stripe'"),
      }),
    )
    .default([]),
  functions: z
    .array(
      z.object({
        ...Loc,
        name: z.string().describe("Exported function name (or a wrapper you exported from evals/harness.ts)"),
        params: z.array(z.object({ name: z.string(), type: z.string(), optional: z.boolean().default(false) })).default([]),
        returns: z.string(),
        outputFields: z.array(z.string()).default([]),
      }),
    )
    .default([]),
});

export type AgentMap = z.infer<typeof AgentMapSchema>;

export const AGENT_MAP_PATH = ".create-evals/agent.json";

/** Every claimed location must exist and actually contain what the map says is there. */
export function verifyAgentMap(root: string, map: AgentMap): string[] {
  const problems: string[] = [];
  const near = (file: string, line: number, needle: string, radius = 3): boolean | "missing" => {
    const abs = path.join(root, file);
    if (!existsSync(abs)) return "missing";
    const lines = readFileSync(abs, "utf8").split("\n");
    if (line > lines.length) return "missing";
    const window = lines.slice(Math.max(0, line - 1 - radius), line + radius).join(" ").replace(/\s+/g, " ");
    return window.includes(needle.replace(/\s+/g, " ").trim());
  };
  const check = (what: string, file: string, line: number, needle: string, radius = 3, alt?: string) => {
    const r = near(file, line, needle, radius);
    if (r === "missing") return problems.push(`${what}: ${file}:${line} doesn't exist`);
    if (r || (alt && near(file, line, alt, radius) === true)) return;
    problems.push(
      `${what}: "${needle.slice(0, 60)}"${alt ? ` (or "${alt}")` : ""} isn't at ${file}:${line} (or within ${radius} lines)${what.startsWith("tool") && !alt ? ". If the tool is defined under another identifier, add it as \"symbol\"" : ""}`,
    );
  };

  check("entry", map.entry.file, map.entry.line, "", 0);
  for (const p of map.prompts) check("prompt", p.file, p.line, p.quote.slice(0, 80));
  for (const t of map.tools) check(`tool ${t.name}`, t.file, t.line, t.name, 8, t.symbol);
  for (const f of map.functions) check(`function ${f.name}`, f.file, f.line, f.name, 1);
  if (map.kind === "conversational" && !map.tools.length) problems.push("no tools listed; if the agent really has none, say so in summary and that's fine");
  return problems.filter((p) => !p.startsWith("no tools"));
}

/** Build (or extend) the model the emitter works from, using what the host agent mapped. */
export function applyAgentMap(base: AgentModel, map: AgentMap): AgentModel {
  const loc = (x: { file: string; line: number }) => ({ file: x.file, line: x.line });
  // When the host agent lists tools, its list is the truth (runtime names, not export names);
  // scanner details are kept for tools it agrees on.
  const tools: ToolDef[] = map.tools.length ? base.tools.filter((u) => map.tools.some((t) => t.name === u.name)) : [...base.tools];
  for (const t of map.tools) {
    if (tools.some((u) => u.name === t.name)) continue;
    tools.push({
      name: t.name,
      symbol: t.symbol,
      description: t.effect ?? "",
      params: t.params.map((name) => ({ name, type: "unknown", optional: false, bounded: false, guarded: false, loc: loc(t), schema: "" })),
      loc: loc(t),
      executeSource: "",
      calls: [],
      returnedFields: [],
      hasApproval: false,
    });
  }

  const agents: AgentDef[] = [...base.agents];
  for (const f of map.functions) {
    if (agents.some((a) => a.name === f.name)) continue;
    agents.push({
      name: f.name,
      framework: base.framework,
      loc: loc(f),
      toolNames: [],
      entry: { kind: "llm-function", ref: { file: f.file, exportName: f.name }, params: f.params.map((p) => ({ ...p, optional: p.optional ?? false })), returnType: f.returns },
      outputFields: f.outputFields.map((name) => ({ name, example: "", loc: loc(f), codeRefs: [] })),
      promptInputs: [],
    });
  }
  if (map.kind === "conversational" && !agents.some((a) => a.entry && a.entry.kind !== "llm-function")) {
    agents.push({ name: map.entry.how.slice(0, 60), framework: base.framework, loc: loc(map.entry), toolNames: tools.map((t) => t.name) });
  }

  return {
    ...base,
    framework: base.agents.length || base.tools.length ? base.framework : "custom",
    providerEnv: (Array.isArray(map.providerEnv) ? map.providerEnv[0] : map.providerEnv) ?? base.providerEnv,
    requiredEnv: Array.isArray(map.providerEnv) ? map.providerEnv : undefined,
    tools,
    agents,
  };
}

export function readAgentMap(root: string): { map?: AgentMap; problems: string[] } {
  const file = path.join(root, AGENT_MAP_PATH);
  if (!existsSync(file)) return { problems: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    return { problems: [`${AGENT_MAP_PATH} isn't valid JSON: ${(e as Error).message}`] };
  }
  const parsed = AgentMapSchema.safeParse(raw);
  if (!parsed.success) return { problems: parsed.error.issues.map((i) => `${AGENT_MAP_PATH} ${i.path.join(".")}: ${i.message}`) };
  return { map: parsed.data, problems: verifyAgentMap(root, parsed.data) };
}
