import { Node, SyntaxKind, type SourceFile } from "ts-morph";
import type { AgentDef, FunctionParam, OutputField, PromptDef, PromptInput, ToolDef } from "../../core/types.js";
import { getProp, importRefFor, locOf, relPath, resolveValue, type ScanContext } from "../project.js";
import { extractPrompt } from "../prompts.js";
import type { Adapter } from "./types.js";

// Agents written directly against a provider SDK: an exported function builds a prompt, calls
// `client.chat.completions.create` / `client.responses.create` / `client.messages.create`, and
// returns something structured. Most production LLM code looks like this, not like a chat loop.

const OPENAI_CALL = /\.(chat\.completions\.(create|stream|parse)|responses\.(create|stream|parse))$/;
const ANTHROPIC_CALL = /\.messages\.(create|stream|parse)$/;

export const llmSdk: Adapter = {
  framework: "openai-sdk",
  packages: ["openai", "@anthropic-ai/sdk"],
  scan(ctx) {
    const agents: AgentDef[] = [];
    const tools: ToolDef[] = [];
    const seen = new Set<Node>();

    for (const sf of ctx.files) {
      for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const callee = call.getExpression().getText().replace(/\s+/g, "");
        const provider = OPENAI_CALL.test(callee) ? "openai" : ANTHROPIC_CALL.test(callee) && !callee.includes("completions") ? "anthropic" : undefined;
        if (!provider) continue;
        const cfg = call.getArguments()[0];
        if (!cfg || !Node.isObjectLiteralExpression(cfg)) continue;

        const fn = exportedFunction(call);
        if (!fn || seen.has(fn.node)) continue;
        seen.add(fn.node);
        const ref = { file: relPath(ctx.root, sf.getFilePath()), exportName: fn.name };

        const { system, user } = promptParts(cfg, provider);
        const prompt = system ? longestPrompt(ctx, system) : undefined;
        const params = fn.params;

        agents.push({
          name: fn.name,
          framework: provider === "openai" ? "openai-sdk" : "anthropic-sdk",
          loc: locOf(ctx, fn.node),
          prompt,
          toolNames: [],
          model: getProp(cfg, "model")?.getText().replace(/\s+/g, " "),
          entry: { kind: "llm-function", ref, params, returnType: fn.returnType },
          outputFields: prompt ? outputFields(ctx, prompt) : [],
          promptInputs: user ? promptInputs(ctx, user, params) : [],
          paramTypes: paramTypeDecls(fn.node),
          source: fn.node.getText().slice(0, 6000),
        });
      }
    }
    return { tools, agents };
  },
};

interface FoundFunction {
  node: Node;
  name: string;
  params: FunctionParam[];
  returnType: string;
}

function exportedFunction(call: Node): FoundFunction | undefined {
  for (let n: Node | undefined = call.getParent(); n; n = n.getParent()) {
    let name: string | undefined;
    let fnNode: Node | undefined;
    if (Node.isFunctionDeclaration(n) && n.isExported()) {
      name = n.getName();
      fnNode = n;
    } else if ((Node.isArrowFunction(n) || Node.isFunctionExpression(n)) && Node.isVariableDeclaration(n.getParent()!)) {
      const decl = n.getParentOrThrow() as import("ts-morph").VariableDeclaration;
      if (decl.getVariableStatement()?.isExported()) {
        name = decl.getName();
        fnNode = n;
      }
    }
    if (name && fnNode) {
      const f = fnNode as import("ts-morph").FunctionDeclaration;
      return {
        node: fnNode,
        name,
        params: f.getParameters().map((p) => ({ name: p.getName(), type: p.getTypeNode()?.getText() ?? "unknown", optional: p.isOptional() || p.hasInitializer() })),
        returnType: (f.getReturnTypeNode()?.getText() ?? f.getReturnType().getText(f)).replace(/\s+/g, " ").slice(0, 600),
      };
    }
  }
  return undefined;
}

/** The system prompt expression and the user message expression in a provider call. */
function promptParts(cfg: Node, provider: "openai" | "anthropic"): { system?: Node; user?: Node } {
  let system = getProp(cfg, provider === "anthropic" ? "system" : "instructions");
  let user: Node | undefined;
  const list = getProp(cfg, "messages") ?? getProp(cfg, "input");
  const arr = list && resolveValue(list);
  if (arr && Node.isArrayLiteralExpression(arr)) {
    for (const el of arr.getElements()) {
      const obj = resolveValue(el);
      if (!Node.isObjectLiteralExpression(obj)) continue;
      const role = getProp(obj, "role")?.getText().replace(/['"`]/g, "");
      const content = getProp(obj, "content");
      if ((role === "system" || role === "developer") && content && !system) system = content;
      if (role === "user" && content && !user) user = content;
    }
  }
  return { system, user };
}

/**
 * Prompts are often assembled (`custom ? DEFAULT + "\n" + custom : DEFAULT`). Pick the longest
 * string literal the expression refers to; that's the part the developer actually wrote.
 */
function longestPrompt(ctx: ScanContext, expr: Node): PromptDef | undefined {
  const candidates: Node[] = [];
  const consider = (n: Node) => {
    const v = resolveValue(n);
    if (Node.isStringLiteral(v) || Node.isNoSubstitutionTemplateLiteral(v) || Node.isTemplateExpression(v)) candidates.push(n);
    else if (v !== n) v.forEachDescendant((d) => (Node.isIdentifier(d) ? consider(d) : undefined));
  };
  consider(expr);
  expr.forEachDescendant((d) => (Node.isIdentifier(d) ? consider(d) : undefined));
  const best = candidates
    .map((n) => extractPrompt(ctx, n))
    .filter((p): p is PromptDef => !!p)
    .sort((a, b) => b.text.length - a.text.length)[0];
  return best && best.text.length >= 40 ? best : undefined;
}

/** `"field": example` lines in the prompt's output schema, plus where the code reads each field. */
function outputFields(ctx: ScanContext, prompt: PromptDef): OutputField[] {
  const fields: OutputField[] = [];
  for (const l of prompt.lines) {
    const m = /^"(\w+)"\s*:\s*(.+?),?$/.exec(l.text);
    if (!m || fields.some((f) => f.name === m[1])) continue;
    fields.push({ name: m[1]!, example: m[2]!.slice(0, 80), loc: { file: prompt.file, line: l.line }, codeRefs: [] });
  }
  if (!fields.length) return fields;

  for (const sf of ctx.files) {
    const file = relPath(ctx.root, sf.getFilePath());
    if (file === prompt.file) continue;
    sf.getFullText()
      .split("\n")
      .forEach((text, i) => {
        for (const f of fields) {
          if (new RegExp(`(\\.|\\[['"])${f.name}\\b`).test(text)) f.codeRefs.push({ loc: { file, line: i + 1 }, text: text.trim().slice(0, 200) });
        }
      });
  }
  return fields;
}

/** `${param.x.y}` interpolations in the user message that come from the function's inputs. */
function promptInputs(ctx: ScanContext, user: Node, params: FunctionParam[]): PromptInput[] {
  const tpl = resolveValue(user);
  if (!Node.isTemplateExpression(tpl)) return [];
  const names = new Set(params.map((p) => p.name));
  const out: PromptInput[] = [];
  const add = (expr: string, param: string, at: Node) => {
    if (!out.some((o) => o.expr === expr)) out.push({ expr, param, loc: locOf(ctx, at) });
  };
  for (const span of tpl.getTemplateSpans()) {
    const expr = span.getExpression();
    const visit = (n: Node) => {
      if (Node.isPropertyAccessExpression(n) || Node.isIdentifier(n)) {
        const path = dataPath(n.getText());
        const root = path.split(".")[0]!;
        if (names.has(root)) return add(path, root, n);
        // `${fileContentsSection}` built from a param a few lines up.
        if (Node.isIdentifier(n)) {
          const init = resolveValue(n);
          if (init !== n) {
            const used = init.getDescendantsOfKind(SyntaxKind.Identifier).map((d) => d.getText()).find((t) => names.has(t));
            if (used) return add(`${n.getText()} (from ${used})`, used, n);
          }
        }
      }
      n.forEachChild(visit);
    };
    visit(expr);
  }
  return out;
}

const METHODS = new Set(["join", "map", "slice", "length", "trim", "filter", "toString", "split", "replace", "toLowerCase", "toUpperCase", "concat", "flatMap", "sort", "reduce", "some", "every", "find", "keys", "values", "entries"]);

/** `a.b.c.slice(0, 5).join` → `a.b.c` */
function dataPath(text: string): string {
  const parts: string[] = [];
  for (const seg of text.replace(/\?\./g, ".").split(".")) {
    if (seg.includes("(") || METHODS.has(seg)) break;
    parts.push(seg);
  }
  return parts.join(".") || text;
}

/** Text of the interfaces/types the parameters use (one level deep), capped for prompt size. */
function paramTypeDecls(fn: Node): string {
  const out = new Map<string, string>();
  const visit = (typeNode: Node | undefined, depth: number) => {
    if (!typeNode || depth > 2) return;
    typeNode.forEachDescendant((d) => {
      if (!Node.isTypeReference(d)) return;
      const name = d.getTypeName().getText();
      if (out.has(name)) return;
      const sym = d.getTypeName().getSymbol();
      const target = sym?.isAlias() ? sym.getAliasedSymbol() : sym;
      const decl = target?.getDeclarations()[0];
      if (!decl || decl.getSourceFile().getFilePath().includes("node_modules")) return;
      if (!Node.isInterfaceDeclaration(decl) && !Node.isTypeAliasDeclaration(decl)) return;
      out.set(name, decl.getText());
      visit(decl, depth + 1);
    });
    if (Node.isTypeReference(typeNode)) {
      const sym = typeNode.getTypeName().getSymbol();
      const target = sym?.isAlias() ? sym.getAliasedSymbol() : sym;
      const decl = target?.getDeclarations()[0];
      const name = typeNode.getTypeName().getText();
      if (decl && !out.has(name) && !decl.getSourceFile().getFilePath().includes("node_modules") && (Node.isInterfaceDeclaration(decl) || Node.isTypeAliasDeclaration(decl))) {
        out.set(name, decl.getText());
        visit(decl, depth + 1);
      }
    }
  };
  for (const p of (fn as import("ts-morph").FunctionDeclaration).getParameters()) visit(p.getTypeNode(), 0);
  return [...out.values()].join("\n\n").slice(0, 6000);
}

export type { SourceFile };
