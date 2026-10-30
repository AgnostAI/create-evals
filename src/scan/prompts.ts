import { Node } from "ts-morph";
import type { PromptDef } from "../core/types.js";
import { declarationOf, relPath, resolveValue, type ScanContext } from "./project.js";

/**
 * Resolve a `system:` / `instructions:` value to the literal it's written in, keeping
 * real line numbers so every prompt citation points at the exact line in the user's file.
 */
export function extractPrompt(ctx: ScanContext, value: Node | undefined): PromptDef | undefined {
  if (!value) return undefined;
  const literal = resolveValue(value);
  if (!Node.isStringLiteral(literal) && !Node.isNoSubstitutionTemplateLiteral(literal) && !Node.isTemplateExpression(literal)) {
    return undefined;
  }
  const raw = literal.getText().slice(1, -1);
  const start = literal.getStartLineNumber();
  const file = relPath(ctx.root, literal.getSourceFile().getFilePath());
  const lines = raw
    .split("\n")
    .map((text, i) => ({ line: start + i, text: text.replace(/\\n/g, " ").trim() }))
    .filter((l) => l.text.length > 0);

  let symbol: string | undefined;
  if (Node.isIdentifier(value)) symbol = value.getText();
  else {
    const decl = literal.getParent();
    if (decl && Node.isVariableDeclaration(decl)) symbol = decl.getName();
  }
  const declNode = Node.isIdentifier(value) ? declarationOf(value) : undefined;
  const loc = { file, line: declNode?.getStartLineNumber() ?? start };

  return { symbol, file, loc, lines, text: lines.map((l) => l.text).join("\n") };
}
