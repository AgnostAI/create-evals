import { readFileSync } from "node:fs";
import path from "node:path";
import type { AgentModel, Finding, ToolDef } from "../core/types.js";
import { lineText } from "../scan/project.js";

/** Compact, line-numbered description of the agent for prompts. */
export function describeAgent(model: AgentModel): string {
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
