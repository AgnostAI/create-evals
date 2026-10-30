import { Node, SyntaxKind, type Type } from "ts-morph";
import type { CallSite, ParamType, ToolDef, ToolParam } from "../core/types.js";
import { declarationOf, importRefFor, locOf, relPath, resolveValue, stringValue, type ScanContext } from "./project.js";

/** Parse `z.object({...})` into params. Anything else yields no params. */
export function parseZodObject(ctx: ScanContext, schema: Node | undefined): ToolParam[] {
  if (!schema) return [];
  const node = resolveValue(schema);
  if (!Node.isCallExpression(node)) return [];
  const calleeText = node.getExpression().getText();
  if (!/(^|\.)object$/.test(calleeText)) return [];
  const shape = node.getArguments()[0];
  const obj = shape && resolveValue(shape);
  if (!obj || !Node.isObjectLiteralExpression(obj)) return [];

  const params: ToolParam[] = [];
  for (const p of obj.getProperties()) {
    if (!Node.isPropertyAssignment(p)) continue;
    const text = p.getInitializerOrThrow().getText().replace(/\s+/g, "");
    const type = zodBaseType(text);
    params.push({
      name: p.getName().replace(/^["']|["']$/g, ""),
      type,
      optional: /\.(optional|nullish|default)\(/.test(text),
      bounded: type === "enum" || type === "boolean" || /\.(max|lte|lt|length)\(/.test(text),
      guarded: false,
      description: /\.describe\((["'`])(.*?)\1\)/.exec(p.getInitializerOrThrow().getText())?.[2],
      loc: locOf(ctx, p),
      schema: p.getInitializerOrThrow().getText(),
    });
  }
  return params;
}

function zodBaseType(text: string): ParamType {
  const m = /^z\.(?:coerce\.)?(\w+)\(/.exec(text);
  switch (m?.[1]) {
    case "string":
      return "string";
    case "number":
    case "bigint":
      return "number";
    case "boolean":
      return "boolean";
    case "array":
      return "array";
    case "object":
    case "record":
      return "object";
    case "enum":
    case "nativeEnum":
    case "literal":
      return "enum";
    default:
      return "unknown";
  }
}

export interface ToolParts {
  name: string;
  /** The node the tool object is bound to (variable or property), for symbol + import resolution. */
  binding?: Node;
  description?: Node;
  schema?: Node;
  execute?: Node;
  approval?: Node;
  call: Node;
}

export function buildTool(ctx: ScanContext, parts: ToolParts): ToolDef {
  const params = parseZodObject(ctx, parts.schema);
  const exec = parts.execute;
  const fn = exec && (Node.isMethodDeclaration(exec) ? exec : resolveValue(exec));
  const body = fn && (Node.isArrowFunction(fn) || Node.isFunctionExpression(fn) || Node.isMethodDeclaration(fn) || Node.isFunctionDeclaration(fn)) ? fn : undefined;
  const executeSource = body?.getText() ?? "";

  for (const param of params) {
    const re = new RegExp(`\\b${param.name}\\s*(>=?|<=?)\\s*[\\w$.]+|[\\w$.]+\\s*(>=?|<=?)\\s*\\b${param.name}\\b|Math\\.min\\([^)]*\\b${param.name}\\b`);
    param.guarded = re.test(executeSource);
  }

  const approvalText = parts.approval?.getText();
  const hasApproval =
    (!!approvalText && approvalText !== "false") ||
    /\bsuspend\s*\(/.test(executeSource) ||
    params.some((p) => p.type === "boolean" && /^(confirm|confirmed|approved|approval|userConfirmed)$/i.test(p.name));

  const symbol = parts.binding && Node.isVariableDeclaration(parts.binding) ? parts.binding.getName() : undefined;

  return {
    name: parts.name,
    symbol,
    description: stringValue(parts.description) ?? "",
    params,
    loc: locOf(ctx, parts.binding ?? parts.call),
    executeLoc: body ? locOf(ctx, body) : undefined,
    executeSource,
    calls: body ? callSites(ctx, body) : [],
    returnedFields: body ? returnedFields(body) : [],
    hasApproval,
    importRef: importRefFor(ctx, parts.binding),
  };
}

function callSites(ctx: ScanContext, body: Node): CallSite[] {
  const out: CallSite[] = [];
  const visit = (n: Node) => {
    if (Node.isCallExpression(n) || Node.isNewExpression(n)) {
      const callee = n.getExpression();
      out.push({
        callee: callee.getText().replace(/\s+/g, ""),
        args: (n.getArguments() ?? []).map((a) => a.getText()),
        loc: locOf(ctx, n),
        calleeNotes: calleeNotes(ctx, callee),
      });
    }
  };
  body.forEachDescendant(visit);
  return out;
}

/** Leading comments on the declaration a callee resolves to, when it lives in the repo. */
function calleeNotes(ctx: ScanContext, callee: Node): string | undefined {
  const head = Node.isPropertyAccessExpression(callee) ? leftmost(callee) : callee;
  if (!Node.isIdentifier(head)) return undefined;
  const decl = declarationOf(head);
  if (!decl) return undefined;
  const file = decl.getSourceFile().getFilePath();
  if (file.includes("/node_modules/") || relPath(ctx.root, file).startsWith("..")) return undefined;
  const stmt = Node.isVariableDeclaration(decl) ? decl.getVariableStatement() : decl;
  const comments = stmt?.getLeadingCommentRanges().map((r) => r.getText().replace(/^\/\/\s?|^\/\*+|\*+\/$/g, "").trim());
  return comments?.length ? comments.join(" ") : undefined;
}

function leftmost(n: Node): Node {
  let cur = n;
  while (Node.isPropertyAccessExpression(cur) || Node.isCallExpression(cur)) cur = cur.getExpression();
  return cur;
}

function returnedFields(body: Node): string[] {
  const exprs: Node[] = [];
  if (Node.isArrowFunction(body) && !Node.isBlock(body.getBody())) exprs.push(body.getBody());
  body.forEachDescendant((n, t) => {
    // Don't `return t.skip()`: a truthy return value stops the whole traversal.
    if (Node.isArrowFunction(n) || Node.isFunctionExpression(n) || Node.isFunctionDeclaration(n)) {
      t.skip();
      return;
    }
    if (Node.isReturnStatement(n) && n.getExpression()) exprs.push(n.getExpressionOrThrow());
  });
  const fields = new Set<string>();
  for (const e of exprs) {
    try {
      collectFields(unwrapPromise(e.getType()), fields, 0);
    } catch {
      // Type info is best effort; a missing field list only lowers PII recall.
    }
    if (Node.isObjectLiteralExpression(e)) for (const p of e.getProperties()) if (Node.isPropertyAssignment(p) || Node.isShorthandPropertyAssignment(p)) fields.add(p.getName());
  }
  return [...fields];
}

function unwrapPromise(t: Type): Type {
  const sym = t.getSymbol()?.getName();
  if ((sym === "Promise" || sym === "PromiseLike") && t.getTypeArguments()[0]) return t.getTypeArguments()[0]!;
  return t;
}

function collectFields(t: Type, out: Set<string>, depth: number) {
  if (depth > 2) return;
  const types = t.isUnion() ? t.getUnionTypes() : [t];
  for (const u of types) {
    if (u.isArray()) {
      collectFields(u.getArrayElementTypeOrThrow(), out, depth + 1);
      continue;
    }
    if (!u.isObject() || u.getCallSignatures().length) continue;
    for (const prop of u.getProperties()) {
      out.add(prop.getName());
      const decl = prop.getValueDeclaration();
      if (decl) collectFields(decl.getType(), out, depth + 1);
    }
  }
}

const GENERIC_KEYS = new Set(["tool", "value", "handler", "fn", "impl", "implementation", "def", "definition", "schema", "default", "execute", "run"]);

/** Every object-literal property in the repo whose value refers to `decl`, as [key, objectLiteral]. */
export function referencingKeys(ctx: ScanContext, decl: Node): { key: string; obj: Node }[] {
  const out: { key: string; obj: Node }[] = [];
  for (const sf of ctx.files) {
    sf.forEachDescendant((n) => {
      if (!Node.isPropertyAssignment(n) && !Node.isShorthandPropertyAssignment(n)) return;
      const value = Node.isPropertyAssignment(n) ? n.getInitializer() : n.getNameNode();
      if (!value || !Node.isIdentifier(value)) return;
      const key = n.getName().replace(/^["']|["']$/g, "");
      // `{ name: "x", tool: backgroundJobs }` is a registry entry, not a tool map.
      if (GENERIC_KEYS.has(key)) return;
      if (declarationOf(value) === decl) out.push({ key, obj: n.getParentOrThrow() });
    });
  }
  return out;
}

export function enclosingCall(n: Node) {
  return n.getFirstAncestorByKind(SyntaxKind.CallExpression);
}
