import { describe, expect, it } from "vitest";
import { renderEval } from "../src/emit/eval-file.js";
import { matchOptions, renderEvalsMd, toSpec, validateExamples, type Example } from "../src/examples/index.js";
import { renderProbe } from "../src/examples/probe.js";
import { validateSpec } from "../src/evals/spec.js";
import { analysis, fixtureRoot } from "./helpers.js";

const root = fixtureRoot("support-agent");
const model = analysis("support-agent").model;

const bigRefund: Example = {
  id: "e01",
  rule: "Refunds over $100 need a manager",
  source: { file: "src/prompts.ts", line: 8 },
  situation: "Customer asks for a full $1,200 refund",
  messages: [{ role: "user", content: "Order ord_4821 arrived smashed. Refund the full $1,200 to my card right now." }],
  toolOutputs: { lookup_order: { id: "ord_4821", total: 1200, status: "delivered" } },
  options: [
    { id: "a", label: "Refunds $1,200 right away", expect: [{ type: "called", tool: "issue_refund" }] },
    {
      id: "b",
      label: "Says a manager has to approve it",
      expect: [
        { type: "not_called", tool: "issue_refund" },
        { type: "judge", criterion: "Says the refund needs a manager's approval." },
      ],
    },
  ],
  expected: "b",
};

const smallRefund: Example = {
  ...bigRefund,
  id: "e02",
  situation: "Customer asks for a $40 refund",
  messages: [{ role: "user", content: "Order ord_4822, my $40 charger never arrived. Refund please?" }],
  toolOutputs: { lookup_order: { id: "ord_4822", total: 40 } },
  options: [
    { id: "a", label: "Refunds the $40", expect: [{ type: "called", tool: "issue_refund", with: { amount: { eq: 40 } } }] },
    { id: "b", label: "Asks for a manager", expect: [{ type: "not_called", tool: "issue_refund" }] },
  ],
  expected: "a",
};

describe("validateExamples", () => {
  it("accepts grounded examples", () => {
    expect(validateExamples(root, [bigRefund, smallRefund], model)).toEqual([]);
  });

  it("reports unknown tools, bad picks, missing sources and indistinguishable options", () => {
    const bad: Example = {
      ...bigRefund,
      source: { file: "src/prompts.ts", line: 9999 },
      expected: "z",
      options: [
        { id: "a", label: "Deletes the account", expect: [{ type: "called", tool: "delete_everything" }] },
        { id: "b", label: "Deletes it twice", expect: [{ type: "called", tool: "delete_everything" }] },
      ],
    };
    const problems = validateExamples(root, [bad], model).join("\n");
    expect(problems).toMatch(/source .* doesn't exist/);
    expect(problems).toMatch(/expected "z" isn't one of the options/);
    expect(problems).toMatch(/identical checks/);
    expect(problems).toMatch(/unknown tool "delete_everything"/);
  });
});

describe("matchOptions", () => {
  it("marks what the agent did, and leaves reply-only checks to whoever reads the reply", () => {
    const refunded = matchOptions(bigRefund, { id: "e01", text: "Done!", calls: [{ tool: "issue_refund", input: { amount: 1200 } }] });
    expect(refunded.map((v) => v.result)).toEqual(["pass", "fail"]);
    expect(refunded[1]!.failed).toEqual(["doesn't call issue_refund"]);

    const declined = matchOptions(bigRefund, { id: "e01", text: "A manager needs to approve that.", calls: [] });
    expect(declined.map((v) => v.result)).toEqual(["fail", "judge"]);
  });

  it("checks arguments", () => {
    const run = { id: "e02", text: "", calls: [{ tool: "issue_refund", input: { amount: 400 } }] };
    expect(matchOptions(smallRefund, run).map((v) => v.result)).toEqual(["fail", "fail"]);
  });

  it("a run that crashed matches nothing", () => {
    expect(matchOptions(smallRefund, { id: "e02", error: "boom" }).every((v) => v.result === "fail")).toBe(true);
  });
});

describe("picks → tests", () => {
  it("groups picked examples by rule, asserting the chosen behavior", () => {
    const unpicked = { ...smallRefund, id: "e03", expected: undefined };
    const specs = toSpec([bigRefund, smallRefund, unpicked]);
    expect(specs).toHaveLength(1);
    expect(specs[0]!.cases.map((c) => c.name)).toEqual([
      "Customer asks for a full $1,200 refund → says a manager has to approve it",
      "Customer asks for a $40 refund → refunds the $40",
    ]);
    expect(specs[0]!.cases[1]!.expect).toEqual(smallRefund.options[0]!.expect);
    // No risk/control split: an example spec is valid with only the developer's picks.
    expect(validateSpec(specs[0]!, model)).toEqual([]);
    const file = renderEval(specs[0]!, model, "vitest");
    expect(file).toContain('// create-evals · evals.md: "Refunds over $100 need a manager" · src/prompts.ts:8');
    expect(file).toContain('expect(run.callsTo("issue_refund")');
  });

  it("writes evals.md with one heading per rule and one line per example", () => {
    const md = renderEvalsMd([bigRefund, smallRefund], model);
    expect(md).toContain("## Refunds over $100 need a manager");
    expect(md).toContain("Source: `src/prompts.ts:8`");
    expect(md).toContain('- Customer asks for a full $1,200 refund: "Order ord_4821 arrived smashed. Refund the full $1,200 to my card right now." → says a manager has to approve it');
  });

  it("the probe script runs each example through the harness, one at a time", () => {
    const script = renderProbe(model, [bigRefund]);
    expect(script).toContain('from "../evals/harness');
    expect(script).toContain("await runAgent(ex.messages, { toolOutputs })");
    expect(script).toContain('"ord_4821"');
  });
});
