import type { Finding, Question } from "../core/types.js";
import { lineText } from "../scan/project.js";

export interface QuestionIssue {
  questionId: string;
  problem: string;
}

/**
 * The anti-generic gate. A question survives only if it cites a real line that belongs to its
 * finding, names an identifier from the repo, and isn't a near-duplicate of another question.
 */
export function validateQuestions(root: string, questions: Question[], findings: Finding[]): QuestionIssue[] {
  const issues: QuestionIssue[] = [];
  const byId = new Map(findings.map((f) => [f.id, f]));

  questions.forEach((q, i) => {
    const bad = (problem: string) => issues.push({ questionId: q.id, problem });
    const f = byId.get(q.findingId);
    if (!f) return bad(`unknown findingId "${q.findingId}"`);

    const allowed = [f.loc, ...f.related];
    if (!allowed.some((l) => l.file === q.citation.file && l.line === q.citation.line)) {
      bad(`citation ${q.citation.file}:${q.citation.line} isn't one of the finding's locations (${allowed.map((l) => `${l.file}:${l.line}`).join(", ")})`);
    }
    if (!lineText(root, q.citation)) bad(`citation ${q.citation.file}:${q.citation.line} points at an empty or missing line`);
    if (!q.text.includes(`${q.citation.file}:${q.citation.line}`)) bad(`text must include the citation "${q.citation.file}:${q.citation.line}"`);

    const quote = typeof f.facts.quote === "string" ? f.facts.quote : "";
    const namesSymbol = f.symbols.some((s) => s.length > 2 && q.text.includes(s));
    const quotesPrompt = quote.length > 0 && longestSharedRun(q.text, quote) >= 12;
    if (!namesSymbol && !quotesPrompt) bad(`must name one of ${f.symbols.map((s) => `\`${s}\``).join(", ")}${quote ? " or quote the prompt line" : ""}`);

    if (!/\?\s*(\(y\/n\))?\s*$/i.test(q.text)) bad("must end with a yes/no question");
    if (q.text.length > 420) bad(`too long (${q.text.length} chars, max 420)`);

    for (const other of questions.slice(0, i)) {
      if (other.findingId === q.findingId) bad(`duplicates ${other.id} (same finding)`);
      else {
        const sameTool = byId.get(other.findingId)?.tool === f.tool && !!f.tool;
        if (similarity(other.text, q.text) > (sameTool ? 0.75 : 0.92)) bad(`near-duplicate of ${other.id}`);
      }
    }
  });
  return issues;
}

function words(s: string) {
  return new Set(s.toLowerCase().match(/[a-z0-9_]+/g) ?? []);
}

function similarity(a: string, b: string): number {
  const A = words(a);
  const B = words(b);
  const inter = [...A].filter((w) => B.has(w)).length;
  return inter / Math.max(1, Math.min(A.size, B.size));
}

function longestSharedRun(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  let best = 0;
  for (let i = 0; i < y.length; i++) {
    for (let len = best + 1; i + len <= y.length; len++) {
      if (!x.includes(y.slice(i, i + len))) break;
      best = len;
    }
  }
  return best;
}
