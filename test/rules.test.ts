import { describe, expect, it } from "vitest";
import { lineText } from "../src/scan/project.js";
import { analysis, expected, FIXTURES, fixtureRoot } from "./helpers.js";

describe("risk rules", () => {
  it.each(FIXTURES)("%s: finds every planted risk at the exact line", (f) => {
    const { findings } = analysis(f);
    const missing = expected(f).planted.filter((p) => !findings.some((x) => x.id === p.id && `${x.loc.file}:${x.loc.line}` === p.at));
    expect(missing).toEqual([]);
  });

  it.each(FIXTURES)("%s: every finding cites a real, non-empty line", (f) => {
    for (const x of analysis(f).findings) {
      expect(lineText(fixtureRoot(f), x.loc), x.id).not.toBe("");
      for (const r of x.related) expect(lineText(fixtureRoot(f), r), `${x.id} related`).not.toBe("");
    }
  });

  it.each(FIXTURES)("%s: picks up to 10, at most 3 per tool, no duplicate tool+param", (f) => {
    const { picked } = analysis(f);
    expect(picked.length).toBeGreaterThanOrEqual(8);
    expect(picked.length).toBeLessThanOrEqual(10);
    const perTool = new Map<string, number>();
    for (const x of picked) if (x.tool) perTool.set(x.tool, (perTool.get(x.tool) ?? 0) + 1);
    expect(Math.max(...perTool.values())).toBeLessThanOrEqual(3);
    const keys = picked.filter((x) => x.param).map((x) => `${x.tool}:${x.param}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("a prompt policy subsumes the matching missing-limit finding", () => {
    const ids = analysis("support-agent").picked.map((x) => x.id);
    expect(ids).toContain("prompt-unenforced-policy:issue_refund:amount");
    expect(ids).not.toContain("missing-limit:issue_refund:amount");
  });
});
