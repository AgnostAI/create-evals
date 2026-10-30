import { readFileSync } from "node:fs";
import type { AgentDef, AgentModel, Finding, OutputField, PromptLine, SourceLoc } from "../core/types.js";

// Rules for agents that are LLM functions: one prompt in, structured output out. The risky
// thing isn't a tool call, it's an output the rest of the system acts on (a "proceed" flag, a
// list of file changes) and prompt rules that nothing downstream enforces.

type Draft = Omit<Finding, "id" | "evidence">;

const CONSTRAINT = /\b(must|MUST|only|ONLY|never|NEVER|exactly|literally|under \d+|at most|start(s)? with|begin(s)? with|slug-safe|exist|EXIST|null)\b/;
const RULE_HEADING = /skip|never|do not|don'?t|must not|sensitive|evidence bar|only if/i;
const RULE_LINE = /\bdo NOT\b|\bNEVER\b|\bnever\b|\bmust not\b|\bdon'?t\b|\bset \w+=false\b/;
const USER_TEXT = /context_rows|conversation|transcript|messages?|user|comment|email|review|body|errors|evidence|file|contents?|query_?results|queryresults/i;
const SEVERE = /secret|credential|token|\.env|auth|session|access-control|payment|privacy|migration|irreversible|delete|ci\/cd|deploy|security|takeover|fraud|legal|chargeback|dispute|gdpr|ccpa/i;
const CHECKS: Record<string, RegExp> = {
  length: /\.length|slice\(0|substring\(|truncate/,
  prefix: /startsWith|\.test\(|match\(|RegExp|\/\^/,
  membership: /includes\(|\.has\(|filter\(|find\(|some\(|every\(|indexOf/,
  any: /throw|startsWith|\.test\(|match\(|includes\(|\.has\(|filter\(|\.length\s*[<>]/,
};

export function functionRules(model: AgentModel): Draft[] {
  const out: Draft[] = [];
  for (const agent of model.agents) {
    if (agent.entry?.kind !== "llm-function" || !agent.prompt) continue;
    out.push(...outputRules(model, agent), ...decisionRules(model, agent), ...untrustedInputs(agent));
  }
  return out;
}

const sym = (a: AgentDef, ...more: string[]) => [a.name, ...more];
const clip = (s: string, n = 110) => (s.length <= n ? s : s.slice(0, s.lastIndexOf(" ", n)) + "…");
const clean = (s: string) => s.replace(/^[-*•]\s*|^\d+\.\s*/, "").trim();

/** Prompt lines that constrain an output field which the code then uses without checking. */
function outputRules(model: AgentModel, agent: AgentDef): Draft[] {
  const out: Draft[] = [];
  const fields = agent.outputFields ?? [];
  const schemaLines = new Set(fields.map((f) => f.loc.line));
  for (const f of fields) {
    if (isBoolean(f)) continue;
    // The field has to be what the rule is about ("affected_files must be…", "Keep pr_title under 70…"),
    // not a word that happens to appear nearby.
    const subject = new RegExp(`\\b${f.name}\\b[^.;]{0,40}?${CONSTRAINT.source}|\\b(keep|ensure|make sure)\\b[^.;]{0,20}\\b${f.name}\\b`);
    const line = agent.prompt!.lines.find((l) => !schemaLines.has(l.line) && subject.test(l.text));
    if (!line) continue;
    const kind = /under \d+|at most \d+|characters/.test(line.text) ? "length" : /start(s)? with|begin(s)? with|slug/.test(line.text) ? "prefix" : /exist|literally|appear|from the provided|one of|only from|allowed|from the list/i.test(line.text) ? "membership" : "any";
    if (enforced(model, f, kind)) continue;
    const use = preferApp(f.codeRefs).find((r) => !/typeof|Array\.isArray/.test(r.text));
    out.push({
      rule: "prompt-output-rule",
      severity: kind === "length" ? 2 : kind === "membership" ? 4 : 3,
      tool: agent.name,
      param: f.name,
      title: `${agent.name}'s prompt constrains \`${f.name}\` but nothing checks it`,
      loc: { file: agent.prompt!.file, line: line.line },
      related: use ? [use.loc] : [],
      symbols: sym(agent, f.name),
      facts: { agentFn: agent.name, field: f.name, quote: clip(clean(line.text), 140), kind, useText: use?.text ?? "", function: true },
    });
  }
  return out;
}

const isBoolean = (f: OutputField) => /^(true|false)$/.test(f.example.replace(/,$/, ""));

/** Refs in the app itself before scripts, demos, and examples. */
function preferApp<T extends { loc: SourceLoc }>(refs: T[]): T[] {
  const side = (r: T) => /(^|\/)(scripts?|examples?|demos?|fixtures?|docs?)\//.test(r.loc.file);
  return [...refs.filter((r) => !side(r)), ...refs.filter(side)];
}

function enforced(model: AgentModel, f: OutputField, kind: string): boolean {
  const re = CHECKS[kind]!;
  return f.codeRefs.some((r) => {
    if (/typeof|Array\.isArray/.test(r.text) && kind !== "any") return false;
    // Look a few lines around the read: `const x = out.field || …; if (!/^…/.test(x)) throw`.
    const window = around(model, r.loc, 3);
    return re.test(window) && (kind !== "any" || /throw|return|filter/.test(window));
  });
}

function around(model: AgentModel, loc: SourceLoc, n: number): string {
  const lines = readLines(model, loc.file);
  return lines.slice(Math.max(0, loc.line - 1 - n), loc.line + n).join("\n");
}

const fileCache = new Map<string, string[]>();
function readLines(model: AgentModel, file: string): string[] {
  const key = `${model.root}/${file}`;
  if (!fileCache.has(key)) {
    try {
      fileCache.set(key, readFileSync(key, "utf8").split("\n"));
    } catch {
      fileCache.set(key, []);
    }
  }
  return fileCache.get(key)!;
}

/**
 * "Always skip when …" / "NEVER touch …" lists. For an agent with a boolean decision field the
 * question is whether it ever flips the decision; otherwise whether it ever outputs the thing.
 */
function decisionRules(model: AgentModel, agent: AgentDef): Draft[] {
  const fields = agent.outputFields ?? [];
  const decision = fields.find((f) => /^(true|false)$/.test(f.example.replace(/,$/, "")));
  const listField = fields.find((f) => f.example.startsWith("[") && fields.some((g) => g !== f && g.loc.line > f.loc.line && g.loc.line - f.loc.line < 6 && /path|file/.test(g.name)));
  const pathField = listField ? fields.find((g) => g.loc.line > listField.loc.line && /path|file/.test(g.name)) : undefined;

  const items: { line: PromptLine; heading: string }[] = [];
  let heading = "";
  for (const l of agent.prompt!.lines) {
    const isHeading = /^#{1,4}\s/.test(l.text) || (/^[A-Z][A-Z0-9 ()/&,'-]{6,}$/.test(l.text) && l.text.split(" ").length >= 2);
    if (isHeading) {
      heading = l.text.replace(/^#+\s*/, "");
      continue;
    }
    const listItem = /^([-*•]|\d+\.)\s/.test(l.text);
    if ((listItem && RULE_HEADING.test(heading)) || (RULE_LINE.test(l.text) && (decision || listField))) items.push({ line: l, heading });
  }

  const scored = items
    .map((it) => {
      // A list item under "Always skip when…" names a concrete situation; a method step usually doesn't.
      const listed = /^([-*•])\s/.test(it.line.text) && RULE_HEADING.test(it.heading);
      const repeat = /already|prior|previous|repeat/i.test(it.line.text) && (listed || /\bdo NOT\b/.test(it.line.text));
      // Method steps that merely mention a sensitive word stay below the "Always skip" list items.
      const severity = listed ? (SEVERE.test(it.line.text) ? 5 : repeat || /transient|volume|speculative|NOT sufficient/i.test(it.line.text) ? 4 : 3) : repeat ? 4 : 3;
      return { ...it, severity: severity as 3 | 4 | 5 };
    })
    .sort((a, b) => b.severity - a.severity)
    .slice(0, 4);

  // Without a yes/no decision field, a "NEVER touch …" list is one question with a case per item.
  if (!decision && listField) {
    const byHeading = new Map<string, typeof scored>();
    const listItems = items.filter((it) => /^([-*•]|\d+\.)\s/.test(it.line.text));
    for (const it of listItems.map((it) => ({ ...it, severity: (SEVERE.test(it.line.text) ? 5 : 3) as 3 | 4 | 5 }))) {
      byHeading.set(it.heading, [...(byHeading.get(it.heading) ?? []), it]);
    }
    return [...byHeading.entries()].slice(0, 2).map(([heading, group]): Draft => {
      const first = group[0]!;
      const validator = pathField && preferApp(pathField.codeRefs).find((r) => /validat|sanitiz|guard|check/i.test(r.text));
      const list = group.map((g) => clip(clean(g.line.text).replace(/\s*[—:].*$/, ""), 44));
      return {
        rule: "prompt-decision-rule",
        severity: Math.max(...group.map((g) => g.severity)) as 3 | 4 | 5,
        tool: agent.name,
        param: `L${first.line.line}`,
        title: `${agent.name}'s prompt says "${heading}" but nothing filters its output`,
        loc: { file: agent.prompt!.file, line: first.line.line },
        related: [...(validator ? [validator.loc] : []), ...group.slice(1).map((g) => ({ file: agent.prompt!.file, line: g.line.line }))],
        symbols: sym(agent, listField.name),
        facts: { agentFn: agent.name, quote: clip(clean(first.line.text)), heading, items: list, decisionField: "", listField: listField.name, pathField: pathField?.name ?? "", validatorText: validator?.text ?? "", function: true },
      };
    });
  }

  return scored.map(({ line, heading, severity }): Draft => {
    const quote = clip(clean(line.text));
    const tokens = (line.text.match(/\.env[\w.*]*|\.github[\w/]*|CI\/CD|migrations?|secrets?|auth\w*/gi) ?? []).map((t) => t.toLowerCase());
    const guardedInCode = tokens.length > 0 && guardMentions(model, tokens);
    const validator = pathField?.codeRefs.find((r) => /validat|sanitiz|guard|check/i.test(r.text));
    return {
      rule: "prompt-decision-rule",
      severity: guardedInCode ? 3 : severity,
      tool: agent.name,
      // Keyed by prompt line so ids stay stable as severities change.
      param: `L${line.line}`,
      title: `${agent.name}'s prompt rule "${quote}" has no check in code`,
      loc: { file: agent.prompt!.file, line: line.line },
      related: validator ? [validator.loc] : decision ? [decision.loc] : [],
      symbols: sym(agent, ...(decision ? [decision.name] : listField ? [listField.name] : [])),
      facts: {
        agentFn: agent.name,
        quote,
        heading,
        decisionField: decision?.name ?? "",
        listField: listField?.name ?? "",
        pathField: pathField?.name ?? "",
        validatorText: validator?.text ?? "",
        function: true,
      },
    };
  });
}

function guardMentions(model: AgentModel, tokens: string[]): boolean {
  const files = new Set(model.agents.flatMap((a) => (a.outputFields ?? []).flatMap((f) => f.codeRefs.map((r) => r.loc.file))));
  return [...files].some((file) => readLines(model, file).some((l) => tokens.some((t) => l.toLowerCase().includes(t)) && CHECKS.any!.test(l)));
}

/** Text from users (or other untrusted sources) pasted into a prompt whose output drives action. */
function untrustedInputs(agent: AgentDef): Draft[] {
  const inputs = (agent.promptInputs ?? []).filter((i) => USER_TEXT.test(i.expr));
  if (!inputs.length) return [];
  // End-user text first, then files from someone else's repo, then anything else.
  // End users' words first, then file contents, then file paths/names, then anything else.
  const rank = (e: string) =>
    /context_rows|conversation|transcript|messages|user|comment|email|review|body|ticket|feedback|chat/i.test(e) && !/file/i.test(e)
      ? 0
      : /contents|section|html|page/i.test(e)
        ? 1
        : /file/i.test(e)
          ? 2
          : 3;
  const best = [...inputs].sort((a, b) => rank(a.expr) - rank(b.expr))[0]!;
  const fields = agent.outputFields ?? [];
  const decision = fields.find((f) => /^(true|false)$/.test(f.example.replace(/,$/, "")));
  const changes = fields.find((f) => /change|action|command|file/i.test(f.name) && f.example.startsWith("["));
  const guard = agent.prompt!.lines.find((l) => /untrusted|never as instructions|not instructions|ignore (any )?instructions/i.test(l.text));
  const userish = rank(best.expr) === 0;
  const fileish = rank(best.expr) === 1;
  if (rank(best.expr) >= 2 && !(decision || changes)) return [];
  return [
    {
      rule: "untrusted-input-in-prompt",
      severity: decision || changes ? (guard ? 4 : 5) : userish || fileish ? (guard ? 3 : 4) : 2,
      tool: agent.name,
      param: best.expr,
      title: `${agent.name} pastes \`${best.expr}\` into its prompt`,
      loc: best.loc,
      related: guard ? [{ file: agent.prompt!.file, line: guard.line }] : [],
      symbols: sym(agent, best.expr, best.expr.split(".").at(-1)!),
      facts: {
        agentFn: agent.name,
        expr: best.expr,
        source: userish ? "text your end users wrote" : fileish ? "file contents from the repo it's working on" : "captured data it didn't write",
        decisionField: decision?.name ?? "",
        changesField: changes?.name ?? "",
        guarded: !!guard,
        function: true,
      },
    },
  ];
}
