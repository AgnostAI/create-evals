import type { AgentDefinition } from "./agent.js";
import { DEFAULT_MODELS, model, ModelError } from "./llm.js";
import { render } from "./trace.js";
import type { Profile, Trace } from "./types.js";

export interface ScenarioResult {
  trace: Trace;
  /** What the session reported as its end state. */
  state: any;
  /** The rendered conversation, for text checks. */
  transcript: string;
  /** Everything the agent said, joined. */
  said: string;
}

export interface ScenarioOptions {
  /** The simulated user for this test. Usually taken from the failing trace's profile, sharpened. */
  profile?: Omit<Profile, "id"> & { id?: string };
  /** For function agents: the input, instead of `profile: { input }`. */
  input?: unknown;
  /**
   * The test is expected to fail until something else changes (e.g. the output needs a new field). Say what.
   * It runs and is reported, but never counts as a failure; when it starts passing, you're told to drop `pending`.
   */
  pending?: string;
  /** Throw (e.g. with node:assert) when the agent got it wrong. Check end state and actions first; text last. */
  check?: (r: ScenarioResult) => void | Promise<void>;
  /** Conversations per test run. Default 1, or CREATE_EVALS_RUNS. */
  runs?: number;
  /** Passing runs needed. Default: all of them for "always", two thirds for "usually". */
  atLeast?: number;
  /** "usually" (default for new tests) never blocks CI on its own; "always" does. */
  tier?: "always" | "usually";
  /** Basic checks this test tolerates, e.g. ["repeated-reply"]. */
  allow?: string[];
}

export interface Registered {
  agent: AgentDefinition;
  name: string;
  file: string;
  opts: ScenarioOptions;
}

const registry: Registered[] = ((globalThis as any)[Symbol.for("create-evals.registry")] ??= []);
let currentFile = "";

export function setCurrentFile(file: string) {
  currentFile = file;
}

export function registered(): Registered[] {
  return registry;
}

/** Declare a test: a simulated conversation plus what must (not) happen in it. Run with `create-evals test`. */
export function scenario(agent: AgentDefinition, name: string, opts: ScenarioOptions): void {
  if (registry.some((r) => r.name === name)) throw new Error(`Two scenarios are named "${name}".`);
  if (!agent || typeof (agent as any).start !== "function") throw new Error(`scenario "${name}": the first argument must be an agent from defineAgent() (with defineAgents, import the one you mean).`);
  if (!opts.profile && opts.input === undefined) throw new Error(`scenario "${name}": give a profile, or an input for a function agent.`);
  registry.push({ agent, name, file: currentFile, opts });
}

/** The profile a scenario runs: `profile`, with `input` folded in. */
export function scenarioProfile(r: Registered): Profile {
  const p = { ...r.opts.profile, ...(r.opts.input !== undefined ? { input: r.opts.input } : {}) };
  return { id: r.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40), ...p } as Profile;
}

const VERDICT = {
  type: "object",
  properties: { reasoning: { type: "string" }, pass: { type: "boolean" } },
  required: ["reasoning", "pass"],
  additionalProperties: false,
};

/** Ask a model whether the conversation meets one criterion. Use for what only the text can show. */
export async function judge(trace: Trace, criterion: string): Promise<{ pass: boolean; reasoning: string }> {
  return model.json({
    model: DEFAULT_MODELS().judge,
    system: "You grade one transcript of an AI agent against one criterion. Judge only that criterion, from what the transcript shows (including tool calls and end state). If it isn't clearly met, it fails.",
    messages: [{ role: "user", content: `Criterion: ${criterion}\n\nTranscript:\n${render(trace)}` }],
    schema: VERDICT,
    maxTokens: 8000,
  });
}

/** The judge couldn't give a verdict (e.g. the model declined): the run is skipped, not failed. */
export class JudgeUnavailable extends Error {
  name = "JudgeUnavailable";
}

/** `judge()`, throwing when the criterion isn't met. */
export async function expectJudge(trace: Trace, criterion: string): Promise<void> {
  let v: { pass: boolean; reasoning: string };
  try {
    v = await judge(trace, criterion);
  } catch (e) {
    if (e instanceof ModelError) throw new JudgeUnavailable(`judge unavailable: ${e.message}`);
    throw e;
  }
  if (!v.pass) throw new Error(`Judge: "${criterion}" failed: ${v.reasoning}`);
}
