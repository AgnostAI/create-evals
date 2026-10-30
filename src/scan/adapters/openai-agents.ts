import { Node, SyntaxKind } from "ts-morph";
import type { AgentDef, ToolDef } from "../../core/types.js";
import { agentRef, declarationOf, getProp, importRefFor, isFromModule, locOf, resolveValue, stringValue } from "../project.js";
import { extractPrompt } from "../prompts.js";
import { buildTool } from "../tool-shape.js";
import type { Adapter } from "./types.js";

const SDK = ["@openai/agents", "@openai/agents-core"];

export const openaiAgents: Adapter = {
  framework: "openai-agents",
  packages: SDK,
  scan(ctx) {
    const tools: ToolDef[] = [];
    const toolByDecl = new Map<Node, ToolDef>();

    for (const sf of ctx.files) {
      for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const callee = call.getExpression();
        if (!Node.isIdentifier(callee) || callee.getText() !== "tool" || !isFromModule(callee, SDK)) continue;
        const cfg = call.getArguments()[0];
        if (!cfg || !Node.isObjectLiteralExpression(cfg)) continue;
        const parent = call.getParentOrThrow();
        const binding = Node.isVariableDeclaration(parent) ? parent : undefined;
        const def = buildTool(ctx, {
          name: stringValue(getProp(cfg, "name")) ?? binding?.getName() ?? "anonymous_tool",
          binding,
          description: getProp(cfg, "description"),
          schema: getProp(cfg, "parameters"),
          execute: getProp(cfg, "execute"),
          approval: getProp(cfg, "needsApproval"),
          call,
        });
        tools.push(def);
        if (binding) toolByDecl.set(binding, def);
      }
    }

    const agents: AgentDef[] = [];
    for (const sf of ctx.files) {
      for (const expr of sf.getDescendantsOfKind(SyntaxKind.NewExpression)) {
        const callee = expr.getExpression();
        if (callee.getText() !== "Agent" || !isFromModule(callee, SDK)) continue;
        const cfg = expr.getArguments()[0];
        if (!cfg || !Node.isObjectLiteralExpression(cfg)) continue;
        const toolsValue = getProp(cfg, "tools");
        const arr = toolsValue && resolveValue(toolsValue);
        const toolNames: string[] = [];
        if (arr && Node.isArrayLiteralExpression(arr)) {
          for (const el of arr.getElements()) {
            const decl = Node.isIdentifier(el) ? declarationOf(el) : undefined;
            const t = decl && toolByDecl.get(decl);
            if (t) toolNames.push(t.name);
          }
        }
        const decl = expr.getParent();
        const ref = agentRef(ctx, expr);
        agents.push({
          name: stringValue(getProp(cfg, "name")) ?? (decl && Node.isVariableDeclaration(decl) ? decl.getName() : "agent"),
          framework: "openai-agents",
          loc: locOf(ctx, expr),
          prompt: extractPrompt(ctx, getProp(cfg, "instructions")),
          toolNames,
          model: getProp(cfg, "model")?.getText().replace(/\s+/g, " "),
          entry: ref ? { kind: "openai-agent", ref } : undefined,
        });
      }
    }
    return { tools, agents };
  },
};
