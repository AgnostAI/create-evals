import type { AgentModel, Finding, Question } from "./core/types.js";
import { templateQuestion } from "./questions/templates.js";
import { lineText } from "./scan/project.js";
import { rank, suppress } from "./risk/rank.js";
import { runRules } from "./risk/rules.js";
import { applyAgentMap, readAgentMap } from "./core/agent-map.js";
import { repoBase, scan, ScanError } from "./scan/index.js";

export const QUESTION_COUNT = 10;

export interface Analysis {
  model: AgentModel;
  /** Every finding the rules produced. */
  findings: Finding[];
  /** The ones worth asking about, best first. */
  picked: Finding[];
  questions: Question[];
}

export function analyze(root: string, n = QUESTION_COUNT): Analysis {
  const model = scan(root);
  const findings = runRules(model);
  const picked = rank(findings, n);
  return { model, findings, picked, questions: picked.map(templateQuestion) };
}

/** Tools with at least one severe finding: the "had no guardrails" number on the card. */
export function unguardedTools(findings: Finding[]): number {
  return new Set(suppress(findings).filter((f) => f.tool && f.severity >= 4).map((f) => f.tool)).size;
}

/**
 * A question about a model-review finding (proposed by the host agent in skill mode) has no
 * rule behind it. Build the finding from the question so the same citation checks apply.
 */
export function adhocFinding(root: string, q: Question): Finding | undefined {
  const evidence = lineText(root, q.citation);
  if (!evidence) return undefined;
  const symbols = [...q.text.matchAll(/`([^`]+)`|"([^"]{4,})"/g)].map((m) => (m[1] ?? m[2])!).filter((s) => evidence.includes(s));
  return {
    id: q.findingId,
    rule: "model-review",
    severity: 3,
    title: q.text,
    loc: q.citation,
    related: [],
    evidence,
    symbols: symbols.length ? symbols : ["\u0000"],
    facts: { question: q.text },
  };
}

export interface Workspace extends Analysis {
  /** Why the scanner couldn't recognize the agent, if it couldn't. */
  scanError?: string;
  /** Problems with .create-evals/agent.json, if there is one. */
  mapProblems: string[];
  hasMap: boolean;
}

/**
 * What the skill commands work from: the scanner's view when it recognizes the agent, merged
 * with the host agent's map (.create-evals/agent.json). Neither alone is required.
 */
export function workspace(root: string): Workspace {
  let analysis: Analysis;
  let scanError: string | undefined;
  try {
    analysis = analyze(root);
  } catch (e) {
    if (!(e instanceof ScanError) || /No package\.json/.test(e.message)) throw e;
    scanError = e.message;
    analysis = { model: repoBase(root), findings: [], picked: [], questions: [] };
  }
  const { map, problems } = readAgentMap(root);
  const model = map ? applyAgentMap(analysis.model, map) : analysis.model;
  return { ...analysis, model, scanError, mapProblems: problems, hasMap: !!map };
}
