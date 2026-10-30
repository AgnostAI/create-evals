import { Node, SyntaxKind } from "ts-morph";
import type { AgentDef, ToolDef } from "../../core/types.js";
import { getProp, importRefFor, isFromModule, locOf, resolveValue, stringValue } from "../project.js";
import { extractPrompt } from "../prompts.js";
import { buildTool, referencingKeys } from "../tool-shape.js";
import type { Adapter } from "./types.js";

const CORE = [/^@mastra\/core(\/|$)/];

export const mastra: Adapter = {
  framework: "mastra",
  packages: ["@mastra/core"],
  scan(ctx) {
    const tools: ToolDef[] = [];

    for (const sf of ctx.files) {
      for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const callee = call.getExpression();
        if (!Node.isIdentifier(callee) || callee.getText() !== "createTool" || !isFromModule(callee, CORE)) continue;
        const cfg = call.getArguments()[0];
        if (!cfg || !Node.isObjectLiteralExpression(cfg)) continue;
        const parent = call.getParentOrThrow();
        const binding = Node.isVariableDeclaration(parent) ? parent : undefined;
        // Mastra exposes a tool to the model under its key in the agent's `tools` object.
        const key = binding ? referencingKeys(ctx, binding)[0]?.key : undefined;
        const id = stringValue(getProp(cfg, "id"));
        const def = buildTool(ctx, {
          name: key ?? id ?? binding?.getName() ?? "anonymous_tool",
          binding,
          description: getProp(cfg, "description"),
          schema: getProp(cfg, "inputSchema"),
          execute: getProp(cfg, "execute"),
          approval: getProp(cfg, "requireApproval"),
          call,
        });
        if (id && id !== def.name) def.aliases = [id];
        tools.push(def);
      }
    }

    const agents: AgentDef[] = [];
    for (const sf of ctx.files) {
      for (const expr of sf.getDescendantsOfKind(SyntaxKind.NewExpression)) {
        const callee = expr.getExpression();
        if (callee.getText() !== "Agent" || !isFromModule(callee, CORE)) continue;
        const cfg = expr.getArguments()[0];
        if (!cfg || !Node.isObjectLiteralExpression(cfg)) continue;
        const toolsObj = getProp(cfg, "tools") && resolveValue(getProp(cfg, "tools")!);
        const toolNames =
          toolsObj && Node.isObjectLiteralExpression(toolsObj)
            ? toolsObj.getProperties().map((p) => (p as { getName?: () => string }).getName?.() ?? "").filter(Boolean)
            : [];
        const decl = expr.getParent();
        const ref = importRefFor(ctx, decl);
        agents.push({
          name: stringValue(getProp(cfg, "name")) ?? (decl && Node.isVariableDeclaration(decl) ? decl.getName() : "agent"),
          framework: "mastra",
          loc: locOf(ctx, expr),
          prompt: extractPrompt(ctx, getProp(cfg, "instructions")),
          toolNames,
          model: getProp(cfg, "model")?.getText().replace(/\s+/g, " "),
          entry: ref ? { kind: "mastra-agent", ref } : undefined,
        });
      }
    }
    return { tools, agents };
  },
};
