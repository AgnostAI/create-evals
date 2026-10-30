import { describe, expect, it } from "vitest";
import { analysis, expected, FIXTURES } from "./helpers.js";

describe("scan", () => {
  it.each(FIXTURES)("%s: detects the framework the fixture uses", (f) => {
    expect(analysis(f).model.framework).toBe(expected(f).framework);
  });

  it("support-agent: tools, prompt lines, and the generateText entry point", () => {
    const { model } = analysis("support-agent");
    expect(model.tools.map((t) => t.name).sort()).toEqual(
      ["apply_credit", "cancel_subscription", "issue_refund", "lookup_customer", "lookup_order", "search_help_center", "send_email"],
    );
    expect(model.runner).toBe("vitest");
    expect(model.importExtension).toBe(".js");
    const agent = model.agents[0]!;
    expect(agent.entry).toEqual({ kind: "function", ref: { file: "src/agent.ts", exportName: "handleMessage" }, input: "messages", returns: "text" });
    expect(agent.toolsRef).toEqual({ file: "src/tools/index.ts", exportName: "tools" });
    expect(agent.prompt?.lines.find((l) => l.text.includes("$100"))?.line).toBe(8);
  });

  it("support-agent: reads zod params, handler sinks, and returned PII fields", () => {
    const refund = analysis("support-agent").model.tools.find((t) => t.name === "issue_refund")!;
    const amount = refund.params.find((p) => p.name === "amount")!;
    expect(amount).toMatchObject({ type: "number", bounded: false, guarded: false, loc: { file: "src/tools/refund.ts", line: 9 } });
    expect(refund.calls.find((c) => c.callee === "payments.refund")?.calleeNotes).toMatch(/real money/);
    const customer = analysis("support-agent").model.tools.find((t) => t.name === "lookup_customer")!;
    expect(customer.returnedFields).toEqual(expect.arrayContaining(["dateOfBirth", "cardLast4", "address"]));
  });

  it("coding-agent: OpenAI Agents tools and agent export, no test runner", () => {
    const { model } = analysis("coding-agent");
    expect(model.runner).toBeNull();
    expect(model.agents[0]!.entry).toEqual({ kind: "openai-agent", ref: { file: "src/agent.ts", exportName: "devbot" } });
    expect(model.agents[0]!.toolNames).toEqual(["run_shell", "read_file", "write_file", "fetch_url", "git_push"]);
  });

  it("ops-agent: Mastra tools are named by their key in the agent, with the id as alias", () => {
    const { model } = analysis("ops-agent");
    const email = model.tools.find((t) => t.name === "sendBulkEmail")!;
    expect(email.aliases).toEqual(["send_bulk_email"]);
    expect(model.agents[0]!.entry).toEqual({ kind: "mastra-agent", ref: { file: "src/mastra/agents/ops-agent.ts", exportName: "opsAgent" } });
  });
});

describe("scan: LLM-function agents (raw provider SDK)", () => {
  it("triage-agent: finds the exported function, its prompt, output fields, and pasted inputs", () => {
    const { model } = analysis("triage-agent");
    expect(model.framework).toBe("anthropic-sdk");
    expect(model.providerEnv).toBe("ANTHROPIC_API_KEY");
    const fn = model.agents[0]!;
    expect(fn.entry).toMatchObject({ kind: "llm-function", ref: { file: "src/triage.ts", exportName: "triageTicket" } });
    expect(fn.prompt?.symbol).toBe("TRIAGE_PROMPT");
    expect(fn.outputFields?.map((o) => o.name)).toEqual(["category", "priority", "auto_close", "tags", "reply"]);
    expect(fn.promptInputs?.map((i) => i.expr)).toEqual(expect.arrayContaining(["ticket.body", "customer.plan", "allowedTags"]));
    expect(fn.paramTypes).toContain("interface Ticket");
  });
});
