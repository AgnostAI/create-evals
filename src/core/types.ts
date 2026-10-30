// The language-agnostic model of an agent codebase. Scanners produce it, risk rules
// read it, emitters consume it. Adding Python later means a new scanner + emitter;
// nothing in risk/ or questions/ should need to change.

export type Framework = "vercel-ai" | "openai-agents" | "mastra" | "openai-sdk" | "anthropic-sdk";
export type TestRunner = "vitest" | "jest";

/** A 1-based line in a file, path relative to the repo root (always forward slashes). */
export interface SourceLoc {
  file: string;
  line: number;
}

export type ParamType = "string" | "number" | "boolean" | "array" | "object" | "enum" | "unknown";

export interface ToolParam {
  name: string;
  type: ParamType;
  optional: boolean;
  /** Has an upper bound in the schema (.max/.lte/.lt/.length, or an enum). */
  bounded: boolean;
  /** Has a runtime guard in the handler, e.g. `if (amount > 500) throw`. */
  guarded: boolean;
  description?: string;
  loc: SourceLoc;
  /** The schema expression as written, e.g. `z.number().positive()`. */
  schema: string;
}

export interface CallSite {
  /** Callee as written, e.g. `payments.refund`, `execSync`, `fetch`. */
  callee: string;
  /** Raw argument text, used to see which params flow into the call. */
  args: string[];
  loc: SourceLoc;
  /** Leading comments on the callee's declaration, if it lives in this repo. */
  calleeNotes?: string;
}

export interface ToolDef {
  /** The name the model sees. */
  name: string;
  /** The TypeScript identifier the tool is bound to, if any. */
  symbol?: string;
  /** Other names the code uses for it, e.g. a Mastra tool's `id`. */
  aliases?: string[];
  description: string;
  params: ToolParam[];
  loc: SourceLoc;
  executeLoc?: SourceLoc;
  executeSource: string;
  calls: CallSite[];
  /** Object keys the handler returns (best effort), plus fields of returned records. */
  returnedFields: string[];
  /** needsApproval / requireApproval / suspend / an explicit confirm param. */
  hasApproval: boolean;
  /** Where to import the tool object from, for the eval harness. */
  importRef?: ImportRef;
}

export interface ImportRef {
  file: string;
  exportName: string;
  /** The export is a factory (`createAgent()`) that returns the thing, not the thing itself. */
  call?: boolean;
}

export interface PromptLine {
  line: number;
  text: string;
}

export interface PromptDef {
  /** Identifier the prompt is bound to, if any. */
  symbol?: string;
  loc: SourceLoc;
  file: string;
  lines: PromptLine[];
  text: string;
}

export type AgentEntry =
  /** A function that wraps generateText/streamText, e.g. `handleMessage(messages)`. */
  | { kind: "function"; ref: ImportRef; input: "messages" | "string"; returns: "text" | "result" }
  /** An exported ToolLoopAgent (Vercel AI SDK). */
  | { kind: "vercel-agent"; ref: ImportRef }
  /** An exported `new Agent()` from @openai/agents. */
  | { kind: "openai-agent"; ref: ImportRef }
  /** An exported `new Agent()` from @mastra/core. */
  | { kind: "mastra-agent"; ref: ImportRef }
  /**
   * An exported function that calls an LLM and returns something structured, e.g.
   * `runPMAgent(contextBundle, alertPayload)`. Evals call it with generated inputs.
   */
  | { kind: "llm-function"; ref: ImportRef; params: FunctionParam[]; returnType: string };

export interface FunctionParam {
  name: string;
  type: string;
  optional: boolean;
}

/** A field the prompt tells the model to output, e.g. `"should_proceed": true`. */
export interface OutputField {
  name: string;
  /** Example value as written in the prompt's schema, e.g. `true`, `"critical|high"`. */
  example: string;
  loc: SourceLoc;
  /** Code lines outside the prompt that read this field, used to tell if a rule is enforced. */
  codeRefs: { loc: SourceLoc; text: string }[];
}

/** A function input interpolated into the prompt, e.g. `${alertPayload.trigger_data.context_rows}`. */
export interface PromptInput {
  expr: string;
  param: string;
  loc: SourceLoc;
}

export interface AgentDef {
  name: string;
  framework: Framework;
  loc: SourceLoc;
  prompt?: PromptDef;
  toolNames: string[];
  /** Model expression as written, e.g. `anthropic("claude-opus-5-5")`. */
  model?: string;
  entry?: AgentEntry;
  /** How the tools object is reachable when it isn't via the agent itself. */
  toolsRef?: ImportRef;
  /** For llm-function agents: what the prompt says to output. */
  outputFields?: OutputField[];
  /** For llm-function agents: inputs pasted into the prompt. */
  promptInputs?: PromptInput[];
  /** For llm-function agents: declarations of the parameter types, for writing realistic inputs. */
  paramTypes?: string;
  /** For llm-function agents: the function's source, so scenario writers see how inputs reach the prompt. */
  source?: string;
}

export interface AgentModel {
  root: string;
  framework: Framework;
  runner: TestRunner | null;
  /** Whether relative imports in the repo use `.js` extensions (NodeNext style). */
  importExtension: ".js" | "";
  packageManager: "npm" | "pnpm" | "yarn" | "bun";
  dependencies: Record<string, string>;
  agents: AgentDef[];
  tools: ToolDef[];
  prompts: PromptDef[];
  /** Env var the agent's model provider reads, e.g. ANTHROPIC_API_KEY. */
  providerEnv: string;
}

// ---------------------------------------------------------------------------
// Risk findings

export type RuleId =
  | "prompt-unenforced-policy"
  | "arbitrary-exec"
  | "data-exfiltration"
  | "no-confirmation"
  | "missing-limit"
  | "unbounded-list"
  | "unrestricted-path"
  | "injection-surface"
  | "pii-exposure"
  | "description-mismatch"
  | "prompt-autonomy-conflict"
  | "prompt-output-rule"
  | "prompt-decision-rule"
  | "untrusted-input-in-prompt"
  /** Proposed by a model reviewing the code; still has to pass the same citation checks. */
  | "model-review"
  | "secret-in-params";

export interface Finding {
  /** Stable id, e.g. `missing-limit:issue_refund:amount`. */
  id: string;
  rule: RuleId;
  /** 1 (minor) .. 5 (can cause irreversible harm). */
  severity: 1 | 2 | 3 | 4 | 5;
  title: string;
  tool?: string;
  param?: string;
  /** The primary citation every question about this finding must use. */
  loc: SourceLoc;
  /** Secondary citations, e.g. the prompt line a tool contradicts. */
  related: SourceLoc[];
  /** The cited source line(s), verbatim. */
  evidence: string;
  /** Identifiers that a grounded question must mention at least one of. */
  symbols: string[];
  /** Rule-specific facts used by question and eval templates. */
  facts: Record<string, string | number | boolean | string[]>;
}

// ---------------------------------------------------------------------------
// Questions and evals

export interface Question {
  id: string;
  findingId: string;
  rule: RuleId;
  text: string;
  citation: SourceLoc;
  /** What a "yes" and a "no" mean for the eval, in one line each. */
  ifYes: string;
  ifNo: string;
}

export interface AnsweredQuestion extends Question {
  answer: "yes" | "no";
}

export type ArgMatcher = { eq?: string | number | boolean; lte?: number; gte?: number; contains?: string };

export type OutputMatcher = {
  eq?: string | number | boolean | null;
  contains?: string;
  notContains?: string;
  startsWith?: string;
  maxLength?: number;
  lte?: number;
  gte?: number;
  oneOf?: (string | number | boolean)[];
};

export type Assertion =
  | { type: "not_called"; tool: string }
  | { type: "called"; tool: string; with?: Record<string, ArgMatcher> }
  | { type: "max_calls"; tool: string; max: number }
  | { type: "every_call"; tool: string; with: Record<string, ArgMatcher> }
  | { type: "not_contains"; text: string }
  | { type: "judge"; criterion: string }
  /**
   * For llm-function agents: a check on the returned value. `path` is dotted, with `[*]` for
   * every array element (e.g. `changes[*].file_path`). With `allowError`, the function throwing
   * also passes (e.g. refusing to produce output is a safe outcome).
   */
  | { type: "output"; path: string; match: OutputMatcher; allowError?: boolean };

export interface EvalCase {
  name: string;
  /** Control cases check the agent still does the safe thing, so a do-nothing agent can't pass. */
  control: boolean;
  /** For conversational agents. */
  messages?: { role: "user" | "assistant"; content: string }[];
  /** For llm-function agents: the arguments to call the function with. */
  args?: unknown[];
  /** Fake results for tools during this case. Tools not listed return the harness default. */
  toolOutputs?: Record<string, unknown>;
  /**
   * Input-dependent results: the first route whose `inputContains` appears in the call's JSON
   * input wins, e.g. different output for `npm test` vs `git status`. Falls back to toolOutputs.
   */
  toolRoutes?: Record<string, { inputContains: string; output: unknown }[]>;
  expect: Assertion[];
}

export interface EvalSpec {
  questionId: string;
  /** For llm-function agents: which exported function this eval calls. */
  agent?: string;
  slug: string;
  title: string;
  question: string;
  answer: "yes" | "no";
  citation: SourceLoc;
  cases: EvalCase[];
}
