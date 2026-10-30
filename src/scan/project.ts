import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Node, Project, SyntaxKind, type SourceFile } from "ts-morph";
import type { ImportRef, SourceLoc } from "../core/types.js";

const IGNORED_DIRS = /(^|\/)(node_modules|dist|build|out|coverage|\.next|\.mastra|evals|__tests__|test|tests)(\/|$)/;
const IGNORED_FILES = /\.(test|spec|eval)\.[cm]?[jt]sx?$|\.d\.ts$/;

export interface ScanContext {
  /** Set by adapters to share state (e.g. functions already turned into agents). */
  seenFunctions?: Set<unknown>;
  root: string;
  project: Project;
  files: SourceFile[];
}

export function loadProject(root: string): ScanContext {
  const tsconfig = path.join(root, "tsconfig.json");
  const project = new Project({
    // We only parse and resolve; never type-check the user's whole program.
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    compilerOptions: { allowJs: true, jsx: 4 /* react-jsx */ },
    ...(existsSync(tsconfig) ? { tsConfigFilePath: tsconfig } : {}),
  });
  project.addSourceFilesAtPaths([
    path.join(root, "**/*.{ts,tsx,mts,cts,js,mjs}"),
    "!" + path.join(root, "**/node_modules/**"),
  ]);
  const all = project.getSourceFiles();
  const tsCount = all.filter((sf) => /\.(ts|tsx|mts|cts)$/.test(sf.getFilePath())).length;
  const files = all.filter((sf) => {
    const rel = relPath(root, sf.getFilePath());
    if (IGNORED_DIRS.test(rel) || IGNORED_FILES.test(rel)) return false;
    // Built bundles (e.g. a plugin's main.js) are huge and duplicate the real source.
    if (sf.getFullText().length > 150_000) return false;
    if (tsCount >= 3 && /\.(js|mjs|cjs)$/.test(rel)) return false;
    return true;
  });
  return { root, project, files };
}

export function relPath(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join("/");
}

export function locOf(ctx: ScanContext, node: Node): SourceLoc {
  return { file: relPath(ctx.root, node.getSourceFile().getFilePath()), line: node.getStartLineNumber() };
}

/** Source text of one line of a file, trimmed. */
export function lineText(root: string, loc: SourceLoc): string {
  const abs = path.join(root, loc.file);
  if (!existsSync(abs)) return "";
  return (readFileSync(abs, "utf8").split("\n")[loc.line - 1] ?? "").trim();
}

/** Text of a property in an object literal, unwrapped from `as const` etc. */
export function getProp(obj: Node, name: string): Node | undefined {
  if (!Node.isObjectLiteralExpression(obj)) return undefined;
  for (const p of obj.getProperties()) {
    if (Node.isPropertyAssignment(p) && propName(p) === name) return p.getInitializerOrThrow();
    if (Node.isShorthandPropertyAssignment(p) && p.getName() === name) return p.getNameNode();
    if (Node.isMethodDeclaration(p) && p.getName() === name) return p;
  }
  return undefined;
}

export function propName(p: Node): string | undefined {
  if (Node.isPropertyAssignment(p) || Node.isShorthandPropertyAssignment(p) || Node.isMethodDeclaration(p)) {
    const n = p.getNameNode();
    if (Node.isStringLiteral(n) || Node.isNoSubstitutionTemplateLiteral(n)) return n.getLiteralValue();
    return n.getText();
  }
  return undefined;
}

/** Literal string value of a node, following identifiers to their initializers. */
export function stringValue(node: Node | undefined): string | undefined {
  const n = node && resolveValue(node);
  if (!n) return undefined;
  if (Node.isStringLiteral(n) || Node.isNoSubstitutionTemplateLiteral(n)) return n.getLiteralValue();
  if (Node.isTemplateExpression(n)) return n.getText().slice(1, -1);
  return undefined;
}

/**
 * Follow identifiers (including imports) to the expression they're initialised with.
 * Returns the node itself when it can't be resolved further.
 */
export function resolveValue(node: Node, depth = 0): Node {
  if (depth > 6) return node;
  let n = node;
  while (Node.isAsExpression(n) || Node.isParenthesizedExpression(n) || Node.isSatisfiesExpression(n)) n = n.getExpression();
  if (Node.isIdentifier(n)) {
    const decl = declarationOf(n);
    if (decl && Node.isVariableDeclaration(decl)) {
      const init = decl.getInitializer();
      if (init) return resolveValue(init, depth + 1);
    }
  }
  return n;
}

export function declarationOf(id: Node): Node | undefined {
  const parent = id.getParent();
  // `{ tools }` — the name node's own symbol is the property; we want the variable.
  const sym = parent && Node.isShorthandPropertyAssignment(parent) ? parent.getValueSymbol() : id.getSymbol();
  if (!sym) return undefined;
  const target = sym.isAlias() ? sym.getAliasedSymbol() : sym;
  return (target ?? sym).getDeclarations()[0];
}

/** If `decl` is an exported top-level variable, return how to import it. */
export function importRefFor(ctx: ScanContext, decl: Node | undefined): ImportRef | undefined {
  if (!decl || !Node.isVariableDeclaration(decl)) return undefined;
  const stmt = decl.getVariableStatement();
  if (!stmt?.isExported()) return undefined;
  return { file: relPath(ctx.root, decl.getSourceFile().getFilePath()), exportName: decl.getName() };
}

/**
 * How to get an agent built by `new X(...)`: its exported variable, or an exported zero-arg
 * factory that returns it (`export const createAgent = () => new Agent({...})`).
 */
export function agentRef(ctx: ScanContext, expr: Node): ImportRef | undefined {
  const direct = importRefFor(ctx, expr.getParent());
  if (direct) return direct;
  for (let n: Node | undefined = expr.getParent(); n; n = n.getParent()) {
    const isFn = Node.isFunctionDeclaration(n) || ((Node.isArrowFunction(n) || Node.isFunctionExpression(n)) && Node.isVariableDeclaration(n.getParent()!));
    if (!isFn) continue;
    const f = n as import("ts-morph").FunctionDeclaration;
    if (f.getParameters().some((p) => !p.isOptional() && !p.hasInitializer())) return undefined;
    if (Node.isFunctionDeclaration(n)) return n.isExported() && n.getName() ? { file: relPath(ctx.root, n.getSourceFile().getFilePath()), exportName: n.getName()!, call: true } : undefined;
    const ref = importRefFor(ctx, n.getParent());
    return ref ? { ...ref, call: true } : undefined;
  }
  return undefined;
}

/** Name of the module a call's callee was imported from, e.g. `ai` for `tool(...)`. */
export function importSourceOf(callee: Node): string | undefined {
  const id = Node.isPropertyAccessExpression(callee) ? callee.getExpression() : callee;
  if (!Node.isIdentifier(id)) return undefined;
  const sym = id.getSymbol();
  for (const d of sym?.getDeclarations() ?? []) {
    const imp = d.getFirstAncestorByKind(SyntaxKind.ImportDeclaration);
    if (imp) return imp.getModuleSpecifierValue();
  }
  return undefined;
}

export function isFromModule(callee: Node, modules: (string | RegExp)[]): boolean {
  const src = importSourceOf(callee);
  return !!src && modules.some((m) => (typeof m === "string" ? src === m : m.test(src)));
}

export function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}
