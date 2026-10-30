import { readFileSync } from "node:fs";
import path from "node:path";
import type { AgentModel, Finding, ToolDef } from "../core/types.js";
import { lineText } from "../scan/project.js";

/** Compact, line-numbered description of the agent for prompts. */
export function describeAgent(model: AgentModel): string {
  const fns = model.agents.filter((a) => a.entry?.kind === "llm-function");
  if (!model.tools.length && fns.length) {
    return [
      `Framework: ${model.framework} (LLM functions: each takes inputs, calls the model once, returns structured output)`,
      ...fns.map(
        (a) =>
          `- ${a.name}(${(a.entry as { params: { name: string; type: string; optional: boolean }[] }).params.map((p) => `${p.name}${p.optional ? "?" : ""}: ${p.type}`).join(", ")}) → ${(a.entry as { returnType: string }).returnType.slice(0, 200)}  [${a.loc.file}:${a.loc.line}]`,
      ),
    ].join("\n");
  }
  const parts = [`Framework: ${model.framework}`];
  for (const p of model.prompts) {
    parts.push(`System prompt (${p.file}):\n${p.lines.map((l) => `  ${p.file}:${l.line} | ${l.text}`).join("\n")}`);
  }
  parts.push(`Tools:\n${model.tools.map(describeTool).join("\n")}`);
  return parts.join("\n\n");
}

export function describeTool(t: ToolDef): string {
  const params = t.params.map((p) => `${p.name}: ${p.schema.replace(/\s+/g, " ")}`).join(", ") || "(none parsed)";
  return `- ${t.name} (${t.loc.file}:${t.loc.line}) — "${t.description}"\n    params: ${params}\n    approval step: ${t.hasApproval ? "yes" : "none"}`;
}

export function describeFinding(model: AgentModel, f: Finding): string {
  const related = f.related.map((l) => `    ${l.file}:${l.line} | ${lineText(model.root, l)}`).join("\n");
  return [
    `rule: ${f.rule} (severity ${f.severity}/5)`,
    `title: ${f.title}`,
    `cite: ${f.loc.file}:${f.loc.line} | ${f.evidence}`,
    related ? `related:\n${related}` : "",
    `facts: ${JSON.stringify(f.facts)}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Line-numbered source of every file that defines a tool or prompt, capped for prompt size. */
export function numberedSources(model: AgentModel, maxChars = 60_000): string {
  const files = [...new Set([...model.tools.map((t) => t.loc.file), ...model.prompts.map((p) => p.file), ...model.agents.map((a) => a.loc.file)])];
  let out = "";
  for (const file of files) {
    const lines = readFileSync(path.join(model.root, file), "utf8").split("\n");
    const block = `=== ${file}\n${lines.map((l, i) => `${String(i + 1).padStart(4)} | ${l}`).join("\n")}\n\n`;
    if (out.length + block.length > maxChars) break;
    out += block;
  }
  return out;
}

export function handlerSnippet(model: AgentModel, toolName: string | undefined): string {
  const t = model.tools.find((t) => t.name === toolName);
  if (!t) return "";
  return `Handler for ${t.name} (${t.executeLoc?.file}:${t.executeLoc?.line}):\n${t.executeSource.slice(0, 1500)}`;
}

/** Everything a scenario writer needs to call one LLM function with realistic inputs. */
export function describeFunction(model: AgentModel, name: string): string {
  const a = model.agents.find((x) => x.name === name && x.entry?.kind === "llm-function");
  if (!a || a.entry?.kind !== "llm-function") return "";
  return [
    `Function: ${a.name} (${a.loc.file}:${a.loc.line})`,
    `Parameters: ${a.entry.params.map((p) => `${p.name}${p.optional ? "?" : ""}: ${p.type}`).join(", ")}`,
    `Returns: ${a.entry.returnType}`,
    a.paramTypes ? `Parameter types:\n${a.paramTypes}` : "",
    a.prompt ? `Its system prompt (${a.prompt.file}):\n${a.prompt.lines.map((l) => `  ${l.line} | ${l.text}`).join("\n")}` : "",
    a.source ? `Its source (how inputs become the prompt, and what it validates):\n${a.source}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}
