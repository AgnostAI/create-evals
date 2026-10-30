import { Node, SyntaxKind } from "ts-morph";
import type { AgentDef, AgentEntry, ToolDef } from "../../core/types.js";
import { agentRef, declarationOf, getProp, importRefFor, isFromModule, locOf, relPath, resolveValue } from "../project.js";
import { functionAgents } from "./llm-sdk.js";
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
          name: name ?? factoryName(call) ?? "anonymous_tool",
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
    const seenFns = new Set<Node>();
    for (const sf of ctx.files) {
      for (const call of [...sf.getDescendantsOfKind(SyntaxKind.CallExpression), ...sf.getDescendantsOfKind(SyntaxKind.NewExpression)]) {
        const callee = call.getExpression();
        const name = callee.getText();
        const isRunCall = Node.isCallExpression(call) && ["generateText", "streamText", "generateObject", "streamObject"].includes(name);
        const isAgent = Node.isNewExpression(call) && ["ToolLoopAgent", "Experimental_Agent"].includes(name);
        if ((!isRunCall && !isAgent) || !isFromModule(callee, AI)) continue;
        const cfg = call.getArguments()[0];
        if (!cfg || !Node.isObjectLiteralExpression(cfg)) continue;
        const toolsValue = getProp(cfg, "tools");
        if (!toolsValue && isRunCall) {
          // No tools: a function that calls the model and returns something, like a classifier.
          const userNode = getProp(cfg, "prompt") ?? userMessage(getProp(cfg, "messages"));
          const found = functionAgents(ctx, call, { system: getProp(cfg, "system") ?? getProp(cfg, "instructions"), user: userNode }, "vercel-ai", getProp(cfg, "model")?.getText(), seenFns);
          if (found !== "none") agents.push(...found);
          continue;
        }

        const toolsObj = toolsValue ? resolveValue(toolsValue) : undefined;
        const toolNames = toolsObj && Node.isObjectLiteralExpression(toolsObj)
          ? toolsObj.getProperties().map((p) => (p as { getName?: () => string }).getName?.() ?? "").filter(Boolean)
          : [];
        const toolsDecl = toolsValue && Node.isIdentifier(toolsValue) ? declarationOf(toolsValue) : undefined;

        let entry: AgentEntry | undefined;
        let agentName = relPath(ctx.root, sf.getFilePath());
        if (isAgent) {
          const decl = call.getParent();
          const ref = agentRef(ctx, call);
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

    // Keep tools that some agent uses; if no agent's tools could be resolved (built dynamically), keep them all.
    const used = tools.filter((t) => agents.some((a) => a.toolNames.includes(t.name)));
    return { tools: used.length ? used : tools, agents };
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

/** `createBrowserTool = () => tool({...})` → "browser" */
function factoryName(call: Node): string | undefined {
  const fn = call.getFirstAncestor((a) => Node.isFunctionDeclaration(a) || (Node.isArrowFunction(a) && Node.isVariableDeclaration(a.getParent()!)));
  const raw = fn && (Node.isFunctionDeclaration(fn) ? fn.getName() : (fn.getParent() as import("ts-morph").VariableDeclaration).getName());
  return raw?.replace(/^(create|make|build|get)/, "").replace(/Tool$/, "").replace(/^./, (c) => c.toLowerCase()) || undefined;
}

function userMessage(messages: Node | undefined): Node | undefined {
  const arr = messages && resolveValue(messages);
  if (!arr || !Node.isArrayLiteralExpression(arr)) return undefined;
  for (const el of arr.getElements()) {
    const obj = resolveValue(el);
    if (Node.isObjectLiteralExpression(obj) && getProp(obj, "role")?.getText().replace(/['"`]/g, "") === "user") return getProp(obj, "content");
  }
  return undefined;
}
