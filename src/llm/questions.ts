import { z } from "zod";
import type { AgentModel, Finding, Question } from "../core/types.js";
import { templateQuestion } from "../questions/templates.js";
import { validateQuestions } from "../questions/validate.js";
import { lineText } from "../scan/project.js";
import { describeAgent, describeFinding, numberedSources } from "./context.js";
import { askObject, type LLM } from "./provider.js";

const STYLE = `Style for every question:
- One short sentence of context grounded in the code, then one yes/no question. Max ~300 characters.
- Put the citation in parentheses right after the first thing you name, exactly as given: "\`issue_refund\` (src/tools/refund.ts:9) accepts …".
- Wrap every tool, parameter, and code identifier in backticks, exactly as written in the code. Quote prompt lines in double quotes.
- Be concrete: real thresholds, real values, real file names. Never invent behavior the code doesn't show.
- Phrase it as "Should the agent ever …?" so that "no" means "this needs a guardrail".
- A developer should read it and think "huh, it really read my code", never "this could be about any agent".`;

/**
 * Rewrite template questions for flow, then gate them through the validator. Any rewrite that
 * fails falls back to its template, so the result is never less grounded than the templates.
 */
export async function polishQuestions(llm: LLM, model: AgentModel, findings: Finding[]): Promise<Question[]> {
  const drafts = findings.map((f, i) => templateQuestion(f, i));
  const schema = z.object({ questions: z.array(z.object({ findingId: z.string(), text: z.string() })) });
  const prompt = `${describeAgent(model)}

Candidate questions (one per finding). Rewrite each so it reads naturally and is as specific as possible.
Keep every finding, keep the order, keep the same citation.

${findings
  .map((f, i) => `--- findingId: ${f.id}\n${describeFinding(model, f)}\ndraft: ${drafts[i]!.text}`)
  .join("\n\n")}`;

  let rewritten: { findingId: string; text: string }[] = [];
  try {
    rewritten = (await askObject(llm, schema, `You write yes/no questions for a developer about risks in their AI agent's code.\n\n${STYLE}`, prompt)).questions;
  } catch {
    return drafts;
  }

  const candidates = drafts.map((d, i) => {
    const r = rewritten.find((x) => x.findingId === d.findingId);
    return r ? { ...d, text: codeify(r.text.trim(), findings[i]!.symbols) } : d;
  });
  const issues = validateQuestions(model.root, candidates, findings);
  return candidates.map((c, i) => (issues.some((x) => x.questionId === c.id) ? drafts[i]! : c));
}

/**
 * When the rules find fewer than `want` risks, ask the model to review the code for more.
 * Every proposal must cite a real line that contains the identifier it names.
 */
export async function proposeFindings(llm: LLM, model: AgentModel, existing: Finding[], want: number, covered: string[] = []): Promise<Finding[]> {
  if (want <= 0) return [];
  const schema = z.object({
    findings: z.array(
      z.object({
        file: z.string(),
        line: z.number().int(),
        identifier: z.string().describe("An identifier or quoted phrase that appears verbatim on that line"),
        tool: z.string().describe("Tool name this is about, or empty string"),
        title: z.string(),
        question: z.string(),
      }),
    ),
  });
  const prompt = `${numberedSources(model)}
Already covered (don't repeat these, combine them, or ask near-variants):
${existing.map((f) => `- ${f.title} (${f.loc.file}:${f.loc.line})`).join("\n")}${covered.length ? `\n\nQuestions already being asked:\n${covered.map((q) => `- ${q}`).join("\n")}` : ""}

Find up to ${want} more distinct, behavior-level risks in this agent: things the agent could do (or fail to do) in a conversation that the developer would want an eval for. Good sources: tool params with no validation, side effects hidden in handlers, return values that leak data, prompt lines that are vague, contradictory, or unenforced. Skip code-style and infrastructure issues.

For each, write the yes/no question the developer should answer. Cite the single most relevant line.

${STYLE}`;

  let proposals: z.infer<typeof schema>["findings"] = [];
  try {
    proposals = (await askObject(llm, schema, "You review AI agent codebases for behavioral risks worth testing.", prompt.replace(`up to ${want} more`, `up to ${want + 2} more`))).findings;
  } catch (e) {
    if (process.env.CREATE_EVALS_DEBUG) console.error(e);
    return [];
  }
  if (process.env.CREATE_EVALS_DEBUG) console.error(JSON.stringify(proposals, null, 2));

  const out: Finding[] = [];
  for (const p of proposals) {
    const loc = { file: p.file.replace(/^\.\//, ""), line: p.line };
    const evidence = lineText(model.root, loc);
    if (!evidence || !p.identifier || !evidence.includes(p.identifier.replace(/^["'`]|["'`]$/g, ""))) continue;
    const tool = model.tools.find((t) => t.name === p.tool);
    // Anything the question names in backticks/quotes that really is on the cited line counts as grounding.
    const named = [...p.question.matchAll(/`([^`]+)`|"([^"]{4,})"/g)].map((m) => (m[1] ?? m[2])!).filter((x) => evidence.includes(x));
    const f: Finding = {
      id: `model-review:${loc.file}:${loc.line}`,
      rule: "model-review",
      severity: 3,
      title: p.title,
      tool: tool?.name,
      loc,
      related: [],
      evidence,
      symbols: [...new Set([p.identifier.replace(/^["'`]|["'`]$/g, ""), ...named, ...(tool ? [tool.name, ...(tool.symbol ? [tool.symbol] : []), ...(tool.aliases ?? [])] : [])])],
      facts: { question: p.question.includes(`${loc.file}:${loc.line}`) ? p.question : `${p.question.replace(/\?$/, "")} (${loc.file}:${loc.line})?` },
    };
    const q = templateQuestion(f, 0);
    if (validateQuestions(model.root, [q], [f]).length === 0 && !out.some((o) => o.id === f.id) && !existing.some((e) => e.loc.file === loc.file && e.loc.line === loc.line)) {
      out.push(f);
    }
    if (out.length >= want) break;
  }
  return out;
}

/** Backtick known identifiers the model left bare, outside existing code spans and quotes. */
export function codeify(text: string, symbols: string[]): string {
  const ids = symbols.filter((s) => /^[A-Za-z_$][\w$.]*$/.test(s) && /[_.]|[a-z][A-Z]/.test(s)).sort((a, b) => b.length - a.length);
  const wrap = (seg: string) => ids.reduce((acc, id) => acc.replace(new RegExp(`(?<![\\w$.\`])${id.replace(/[.$]/g, "\\$&")}(?![\\w$\`])`, "g"), `\`${id}\``), seg);
  // Leave code spans alone, then leave quoted prompt text alone.
  return text
    .split(/(`[^`]*`)/)
    .map((seg, i) => (i % 2 ? seg : seg.split(/("[^"]*")/).map((part, j) => (j % 2 ? part : wrap(part))).join("")))
    .join("");
}
