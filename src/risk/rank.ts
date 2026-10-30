import type { Finding, RuleId } from "../core/types.js";

/** When two findings on the same tool would produce the same question, keep the sharper one. */
const SUBSUMES: Partial<Record<RuleId, RuleId[]>> = {
  "prompt-unenforced-policy": ["no-confirmation", "missing-limit"],
  "prompt-autonomy-conflict": ["no-confirmation"],
  "description-mismatch": ["arbitrary-exec", "no-confirmation"],
  "arbitrary-exec": ["no-confirmation"],
  "unrestricted-path": ["no-confirmation"],
  "unbounded-list": [],
};

/** Ties broken toward rules that make the most specific questions. */
const RULE_WEIGHT: Record<RuleId, number> = {
  "prompt-unenforced-policy": 6,
  "prompt-autonomy-conflict": 4,
  "data-exfiltration": 4,
  "arbitrary-exec": 3,
  "injection-surface": 3,
  "unrestricted-path": 3,
  "description-mismatch": 3,
  "missing-limit": 2,
  "unbounded-list": 2,
  "pii-exposure": 2,
  "no-confirmation": 1,
  "model-review": 0,
  "untrusted-input-in-prompt": 5,
  "prompt-decision-rule": 4,
  "prompt-output-rule": 3,
};

export function score(f: Finding): number {
  return f.severity * 10 + RULE_WEIGHT[f.rule] + (f.related.length ? 1 : 0);
}

export function suppress(findings: Finding[]): Finding[] {
  return findings.filter((f) => {
    if (!f.tool) return true;
    return !findings.some((g) => {
      if (g === f || g.tool !== f.tool || !(SUBSUMES[g.rule] ?? []).includes(f.rule)) return false;
      // A numeric prompt policy only covers the param it names.
      if (g.rule === "prompt-unenforced-policy" && f.rule === "missing-limit") return g.param === f.param;
      if (g.rule === "arbitrary-exec") return g.severity >= 4;
      return true;
    });
  });
}

/**
 * Pick up to `n` findings: highest score first, at most two per tool, at most three per rule,
 * never two on the same tool+param. A short list beats a padded one.
 */
export function rank(findings: Finding[], n = 10): Finding[] {
  const pool = suppress(findings).sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id));
  const picked: Finding[] = [];
  const perTool = new Map<string, number>();
  const perRule = new Map<RuleId, number>();
  const seenParam = new Set<string>();

  // LLM-function agents have no tools, so everything about one agent shares a "tool" key; give it more room.
  for (const pass of [{ tool: 2, rule: 3, fn: 4 }, { tool: 3, rule: 5, fn: 6 }]) {
    for (const f of pool) {
      if (picked.length >= n) break;
      if (picked.includes(f)) continue;
      // Minor findings only fill in when a repo is small; otherwise model review can do better.
      if (f.severity <= 2 && (pass.tool === 2 || picked.length >= 6)) continue;
      const key = f.tool ? `${f.tool}:${f.param ?? ""}` : f.id;
      if (f.param && seenParam.has(key)) continue;
      if (f.tool && (perTool.get(f.tool) ?? 0) >= (f.facts.function ? pass.fn : pass.tool)) continue;
      if ((perRule.get(f.rule) ?? 0) >= (f.facts.function ? pass.fn : pass.rule)) continue;
      picked.push(f);
      if (f.param) seenParam.add(key);
      if (f.tool) perTool.set(f.tool, (perTool.get(f.tool) ?? 0) + 1);
      perRule.set(f.rule, (perRule.get(f.rule) ?? 0) + 1);
    }
  }
  return picked.sort((a, b) => score(b) - score(a));
}
