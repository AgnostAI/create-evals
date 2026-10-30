import { describe, expect, it } from "vitest";
import type { Question } from "../src/core/types.js";
import { codeify } from "../src/llm/questions.js";
import { validateQuestions } from "../src/questions/validate.js";
import { analysis, FIXTURES, fixtureRoot, sourceText } from "./helpers.js";

describe("questions", () => {
  it.each(FIXTURES)("%s: every template question passes the grounding validator", (f) => {
    const { model, findings, questions } = analysis(f);
    expect(validateQuestions(model.root, questions, findings)).toEqual([]);
  });

  // The failure mode of this whole project is generic questions. Each question must name
  // something that exists in its own repo and in neither of the other two.
  it.each(FIXTURES)("%s: swap test — no question could be asked about another fixture", (f) => {
    const others = FIXTURES.filter((o) => o !== f).map(sourceText);
    for (const q of analysis(f).questions) {
      const named = [...q.text.matchAll(/`([^`]+)`|"([^"]{12,})"/g)].map((m) => (m[1] ?? m[2])!);
      const unique = named.filter((n) => sourceText(f).includes(n) && others.every((o) => !o.includes(n)));
      expect(unique, q.text).not.toEqual([]);
    }
  });

  it("rejects a generic question", () => {
    const { model, findings } = analysis("support-agent");
    const generic: Question = { ...analysis("support-agent").questions[0]!, text: "Should your agent be polite to customers (src/prompts.ts:8)?" };
    expect(validateQuestions(model.root, [generic], findings).map((i) => i.problem).join(" ")).toMatch(/must name one of/);
  });

  it("rejects a citation that isn't the finding's line", () => {
    const { findings } = analysis("support-agent");
    const q = { ...analysis("support-agent").questions[0]!, citation: { file: "src/agent.ts", line: 3 } };
    const problems = validateQuestions(fixtureRoot("support-agent"), [q], findings).map((i) => i.problem);
    expect(problems.join(" ")).toMatch(/isn't one of the finding's locations/);
  });

  it("rejects near-duplicates on the same tool", () => {
    const { findings, questions } = analysis("support-agent");
    const a = questions.find((q) => q.findingId === "no-confirmation:cancel_subscription")!;
    const dup = { ...a, id: "q99", findingId: "no-confirmation:send_email", citation: { file: "src/tools/email.ts", line: 5 }, text: a.text.replace("cancel_subscription", "send_email").replace("subscriptions.ts:5", "email.ts:5") };
    const problems = validateQuestions(fixtureRoot("support-agent"), [a, dup], findings).map((i) => i.problem);
    expect(problems.join(" ")).toMatch(/near-duplicate of/);
  });

  it("codeify backticks bare identifiers but not quoted prompt text or code spans", () => {
    expect(codeify('send_email can mail "send_email docs" and `issue_refund`', ["send_email", "issue_refund"])).toBe(
      '`send_email` can mail "send_email docs" and `issue_refund`',
    );
    expect(codeify("passes branch into `git push origin ${branch}${force ? \" --force\" : \"\"}` now", ["git_push"])).toBe(
      "passes branch into `git push origin ${branch}${force ? \" --force\" : \"\"}` now",
    );
  });
});
