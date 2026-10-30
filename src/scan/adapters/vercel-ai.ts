import { Node, SyntaxKind } from "ts-morph";
import type { AgentDef, AgentEntry, ToolDef } from "../../core/types.js";
import { declarationOf, getProp, importRefFor, isFromModule, locOf, relPath, resolveValue } from "../project.js";
import { extractPrompt } from "../prompts.js";
import { buildTool, referencingKeys } from "../tool-shape.js";
import type { Adapter } from "./types.js";

const AI = ["ai"];

export const vercelAi: Adapter = {
  framework: "vercel-ai",
  packages: ["ai"],
  scan(ctx) {
    const tools: ToolDef[] = [];
    const toolByDecl = new Map<Node, ToolDef>();

    for (const sf of ctx.files) {
      for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const callee = call.getExpression();
        if (!Node.isIdentifier(callee) || !["tool", "dynamicTool"].includes(callee.getText()) || !isFromModule(callee, AI)) continue;
        const cfg = call.getArguments()[0];
        if (!cfg || !Node.isObjectLiteralExpression(cfg)) continue;

        const parent = call.getParentOrThrow();
        const binding = Node.isVariableDeclaration(parent) ? parent : Node.isPropertyAssignment(parent) ? parent : undefined;
        let name = binding && Node.isPropertyAssignment(binding) ? binding.getName() : undefined;
        if (!name && binding) name = referencingKeys(ctx, binding)[0]?.key ?? (binding as { getName(): string }).getName();

        const def = buildTool(ctx, {
          name: name ?? "anonymous_tool",
          binding: binding && Node.isVariableDeclaration(binding) ? binding : undefined,
          description: getProp(cfg, "description"),
          schema: getProp(cfg, "inputSchema") ?? getProp(cfg, "parameters"),
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
      for (const call of [...sf.getDescendantsOfKind(SyntaxKind.CallExpression), ...sf.getDescendantsOfKind(SyntaxKind.NewExpression)]) {
        const callee = call.getExpression();
        const name = callee.getText();
        const isRunCall = Node.isCallExpression(call) && ["generateText", "streamText"].includes(name);
        const isAgent = Node.isNewExpression(call) && ["ToolLoopAgent", "Experimental_Agent"].includes(name);
        if ((!isRunCall && !isAgent) || !isFromModule(callee, AI)) continue;
        const cfg = call.getArguments()[0];
        if (!cfg || !Node.isObjectLiteralExpression(cfg)) continue;
        const toolsValue = getProp(cfg, "tools");
        if (!toolsValue) continue;

        const toolsObj = resolveValue(toolsValue);
        const toolNames = Node.isObjectLiteralExpression(toolsObj)
          ? toolsObj.getProperties().map((p) => (p as { getName?: () => string }).getName?.() ?? "").filter(Boolean)
          : [];
        const toolsDecl = Node.isIdentifier(toolsValue) ? declarationOf(toolsValue) : undefined;

        let entry: AgentEntry | undefined;
        let agentName = relPath(ctx.root, sf.getFilePath());
        if (isAgent) {
          const decl = call.getParent();
          const ref = importRefFor(ctx, decl);
          if (ref) entry = { kind: "vercel-agent", ref };
          if (decl && Node.isVariableDeclaration(decl)) agentName = decl.getName();
        } else {
          const fn = call.getFirstAncestor((a) => Node.isFunctionDeclaration(a) || Node.isArrowFunction(a) || Node.isFunctionExpression(a));
          const ref = fn && functionRef(ctx, fn);
          if (fn && ref) {
            const firstParam = (fn as unknown as { getParameters(): Node[] }).getParameters()[0];
            const paramText = firstParam?.getText() ?? "";
            const body = fn.getText();
            entry = {
              kind: "function",
              ref,
              input: /message/i.test(paramText) ? "messages" : "string",
              returns: /\.text\s*;?\s*\}?\s*$/m.test(body) || /return\s+[\w.]*\.text\b/.test(body) ? "text" : "result",
            };
            agentName = ref.exportName;
          }
        }

        agents.push({
          name: agentName,
          framework: "vercel-ai",
          loc: locOf(ctx, call),
          prompt: extractPrompt(ctx, getProp(cfg, "system") ?? getProp(cfg, "instructions")),
          toolNames,
          model: getProp(cfg, "model") && modelText(getProp(cfg, "model")!),
          entry,
          toolsRef: importRefFor(ctx, toolsDecl),
        });
      }
    }

    return { tools: tools.filter((t) => agents.length === 0 || agents.some((a) => a.toolNames.includes(t.name))), agents };
  },
};

function functionRef(ctx: Parameters<Adapter["scan"]>[0], fn: Node) {
  if (Node.isFunctionDeclaration(fn) && fn.isExported() && fn.getName()) {
    return { file: relPath(ctx.root, fn.getSourceFile().getFilePath()), exportName: fn.getName()! };
  }
  const decl = fn.getParent();
  return importRefFor(ctx, decl);
}

function modelText(n: Node): string {
  const resolved = resolveValue(n);
  return resolved.getText().replace(/\s+/g, " ").slice(0, 120);
}
