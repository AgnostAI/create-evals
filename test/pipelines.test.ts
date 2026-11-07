import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { copyRepo, removeText } from "../src/ablate.js";
import { parseCsv, readRecords, toProfiles } from "../src/import.js";
import { defineAgent, defineAgents } from "../src/index.js";
import { usage, usageLine } from "../src/llm.js";
import { pickAgent } from "../src/project.js";
import { consistency } from "../src/review.js";
import { converse, parseJson } from "../src/run.js";
import { spawnSession } from "../src/spawn.js";
import { describe as describeVariance, leaves, matches, modeRates, variance } from "../src/variance.js";
import { fakeModel } from "./helpers.js";

let restore = () => {};
afterEach(() => restore());

const fn = (name: string, reply: (input: any) => string) =>
  defineAgent({ name, kind: "function", description: name, start: () => ({ send: async (m) => reply(JSON.parse(m)) }) });

const trace = (id: string, profile: string, state: unknown, extra: any = {}): any => ({
  id,
  agent: "triage",
  profile: { id: profile, input: { domain: profile } },
  turns: [{ role: "user", text: "{}" }, { role: "agent", text: JSON.stringify(state) }],
  events: [],
  state,
  ended: "user-done",
  checks: [],
  ...extra,
});

describe("several agents in one binding", () => {
  it("names agents by key, and a profile picks one", () => {
    const triage = { description: "t", start: () => ({ send: async () => "" }) };
    const agents = defineAgents({ triage, research: { description: "r", start: () => ({ send: async () => "" }) } });
    expect(agents.map((a) => a.name)).toEqual(["triage", "research"]);
    // The named export is the same object, so tests importing it get the named agent.
    expect((triage as any).name).toBe("triage");
    expect(pickAgent(agents, "research").description).toBe("r");
    expect(() => pickAgent(agents)).toThrow(/several agents/);
    expect(() => pickAgent(agents, "nope")).toThrow(/No agent named "nope"/);
  });
});

describe("function agents", () => {
  it("turn a JSON reply into the end state when the session has no state()", async () => {
    const t = await converse(fn("triage", (i) => "```json\n" + JSON.stringify({ qualified: i.ok }) + "\n```"), { id: "p", input: { ok: true } });
    expect(t.state).toEqual({ qualified: true });
  });

  it("leave a non-JSON reply alone", async () => {
    const t = await converse(fn("triage", () => "qualified"), { id: "p", input: {} });
    expect(t.state).toBeUndefined();
    expect(parseJson("[1, 2]")).toEqual([1, 2]);
    expect(parseJson("{broken")).toBeUndefined();
  });
});

describe("variance", () => {
  it("flattens outputs by path, and matches declared decision fields by path or last key", () => {
    expect(leaves({ qualified: true, facts: { industry: "Retail" }, tags: ["b", "a"], people: [{ keep: false }] })).toEqual({
      qualified: true,
      "facts.industry": "Retail",
      tags: ["a", "b"],
      "people.length": 1,
      "people[0].keep": false,
    });
    expect(matches("people[3].keep", ["people[].keep"])).toBe(true);
    expect(matches("result.is_services_firm", ["is_*"])).toBe(true);
    expect(matches("result.status", ["relevant"])).toBe(false);
  });

  it("never reports a present value as missing, and ignores free text even when one run happens to be short", () => {
    // Regression: a long value was dropped in some runs and kept in others, so it showed as "(missing)".
    const traces = [
      trace("a1", "acme", { industry: "Retail (grocery, pharmacy, financial services)", sources: ["https://a.example/1", "https://b.example/2", "https://c.example/3"], aliases: "Acme" }),
      trace("a2", "acme", { industry: "Retail", sources: ["https://a.example/1"], aliases: "Acme Corp, ACME Inc. and Acme Holdings" }),
      trace("a3", "acme", { industry: "Retail", sources: ["https://a.example/1"], aliases: "Acme" }),
    ];
    expect(variance(traces)).toEqual([]);
  });

  it("puts yes/no flips first; with declared decisions, only those fields count", () => {
    const traces = [
      trace("x1", "x", { tier: "A", relevant: true, status: "new" }),
      trace("x2", "x", { tier: "B", relevant: true, status: "new" }),
      trace("y1", "y", { tier: "A", relevant: true, status: "new" }),
      trace("y2", "y", { tier: "A", relevant: false, status: "closed" }),
    ];
    const v = variance(traces);
    expect(v.map((x) => [x.profile, x.strong])).toEqual([["y", true], ["x", false]]);
    expect(v[0]!.fields.map((f) => f.field)).toEqual(["relevant", "status"]);
    const declared = variance(traces, { triage: ["status"] });
    expect(declared.map((x) => [x.profile, x.fields.map((f) => f.field)])).toEqual([["y", ["status"]]]);
  });

  it("reports the same input getting different answers, and ignores reasons that only change wording", () => {
    const traces = [
      trace("d1", "datadog", { qualified: true, reason: "a long explanation that differs every single run, one" }),
      trace("d2", "datadog", { qualified: true, reason: "a long explanation that differs every single run, two" }),
      trace("d3", "datadog", { qualified: false, reason: "a long explanation that differs every single run, three" }),
      trace("s1", "stripe", { qualified: false }),
      trace("s2", "stripe", { qualified: false }),
    ];
    const v = variance(traces);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ profile: "datadog", runs: 3, strong: true, fields: [{ field: "qualified", kind: "boolean", values: [["true", 2], ["false", 1]] }] });
    expect(describeVariance(v[0]!)).toBe("qualified: true 2/3, false 1/3");
  });

  it("counts status values as decisions, but not fields inside lists or mixed reviews alone", () => {
    const traces = [
      trace("s1", "acme", { status: "qualified", people: [{ name: "A" }, { name: "B" }] }),
      trace("s2", "acme", { status: "excluded", people: [{ name: "A" }] }),
      trace("p1", "beta", { status: "qualified", people: [{ role: "hiring_manager" }] }),
      trace("p2", "beta", { status: "qualified", people: [{ role: "exec_sponsor" }] }),
    ];
    const v = variance(traces);
    expect(v.map((x) => [x.profile, x.strong])).toEqual([["acme", true], ["beta", false]]);
    // acme found 2 people in one run and 1 in the other: a count, not "(not in output)" per field of the second.
    expect(v[0]!.fields.map((f) => f.field)).toEqual(["status", "people.length"]);
    expect(JSON.stringify(v)).not.toContain("not in output");
    expect(describeVariance(v[0]!)).toBe("status: qualified 1/2, excluded 1/2; +1 more field(s)");
  });

  it("reports a crash as its own outcome, not as fields missing from the output", () => {
    const traces = [trace("c1", "acme", { qualified: true }), trace("c2", "acme", { qualified: true }), trace("c3", "acme", undefined, { ended: "agent-error", turns: [{ role: "user", text: "{}" }, { role: "agent", text: "" }] })];
    const v = variance(traces);
    expect(v[0]!.fields).toEqual([{ field: "outcome", kind: "declared", values: [["ok", 2], ["crashed", 1]] }]);
    expect(JSON.stringify(v)).not.toContain("not in output");
  });

  it("gives a failure mode's rate per repeated input", () => {
    const review = (n: number) => ({ model: "m", problems: Array(n).fill({ turn: 0, what: "x", evidence: "x", severity: "high" }), simulatorIssues: [], summary: "" });
    const traces = [trace("d1", "datadog", {}, { review: review(1) }), trace("d2", "datadog", {}, { review: review(1) }), trace("d3", "datadog", {}, { review: review(0) })];
    // Same output every run, flagged in only 2: the rate is about the reviewer, and it says so.
    expect(modeRates({ id: "m", title: "t", should: "s", severity: "high", traces: ["d1", "d2"], notes: [] }, traces)).toEqual(["datadog: flagged in 2 of 3 runs (same decisions in all; the agent likely erred every time)"]);
    expect(variance(traces)[0]).toMatchObject({ reviewed: 3, withProblems: 2 });
  });
});

describe("consistency", () => {
  it("keeps contradictions backed by two grounded quotes, from runs or instructions", async () => {
    const traces = [trace("t1", "salesforce", { agentVendor: true, why: "Salesforce sells Agentforce, an agent platform" }), trace("t2", "datadog", { qualified: true })];
    const m = fakeModel([
      {
        issues: [
          {
            id: "salesforce-vendor",
            title: "Triage calls Salesforce an agent vendor; research's prompt says it isn't",
            should: "Salesforce is not an agent vendor, in every stage.",
            severity: "high",
            evidence: [
              { source: "r0", quote: "Salesforce sells Agentforce, an agent platform" },
              { source: "research", quote: "Salesforce is not an agent vendor" },
            ],
          },
          { id: "invented", title: "made up", should: "x", severity: "low", evidence: [{ source: "r1", quote: "nowhere in any run at all" }, { source: "r0", quote: "Salesforce sells Agentforce" }] },
          { id: "paper", title: "Prompts disagree", should: "y", severity: "low", evidence: [{ source: "triage", quote: "Qualify agent vendors" }, { source: "research", quote: "Salesforce is not an agent vendor" }] },
        ],
      },
    ]);
    restore = m.restore;
    const agents = [
      { name: "triage", description: "triage", instructions: "Qualify agent vendors." },
      { name: "research", description: "research", instructions: "Salesforce is not an agent vendor." },
    ];
    const modes = await consistency(traces, agents, "claude-test");
    expect(modes.map((x) => x.id)).toEqual(["salesforce-vendor", "paper"]);
    expect(modes[1]!.title).toBe("Prompts disagree (in the prompts; no run quoted)");
    expect(modes[0]).toMatchObject({ kind: "inconsistency", traces: ["t1"] });
    expect(modes[0]!.notes).toEqual(['t1: "Salesforce sells Agentforce, an agent platform"', 'research instructions: "Salesforce is not an agent vendor"']);
    expect(m.calls[0].body.messages[0].content).toContain("=== agent: research ===");
  });
});

describe("import", () => {
  it("reads CSV with quoted JSON cells, and JSONL", () => {
    expect(parseCsv('a,b\n1,"{""x"": 1}"\n"two, three",plain\n')).toEqual([{ a: "1", b: { x: 1 } }, { a: "two, three", b: "plain" }]);
    const dir = mkdtempSync(path.join(tmpdir(), "ce-import-"));
    writeFileSync(path.join(dir, "r.jsonl"), '{"id": "a"}\n{"id": "b"}\n');
    expect(readRecords(path.join(dir, "r.jsonl"))).toEqual([{ id: "a" }, { id: "b" }]);
    writeFileSync(path.join(dir, "r.json"), '{"data": [{"id": "c"}]}');
    expect(readRecords(path.join(dir, "r.json"))).toEqual([{ id: "c" }]);
  });

  it("turns records into function inputs, and logged conversations into replayed users", () => {
    const profiles = toProfiles(
      [
        { domain: "datadog.com", payload: { domain: "datadog.com" } },
        { domain: "datadog.com", payload: { domain: "datadog.com", again: true } },
        { conversation_id: "c9", messages: [{ role: "user", content: "refund order 12" }, { role: "assistant", content: "sure" }, { role: "user", content: "thanks" }] },
      ],
      { inputField: undefined, agent: "triage" },
    );
    expect(profiles[0]).toEqual({ id: "real-datadog-com", agent: "triage", input: { domain: "datadog.com", payload: { domain: "datadog.com" } } });
    expect(profiles[1]!.id).toBe("real-datadog-com-2");
    expect(profiles[2]).toMatchObject({ id: "real-c9", opening: "refund order 12", maxTurns: 4 });
    expect(profiles[2]!.persona).toContain("2. thanks");
    expect(toProfiles([{ domain: "x.io", payload: { a: 1 } }], { inputField: "payload" })[0]!.input).toEqual({ a: 1 });
  });
});

describe("ablate helpers", () => {
  it("copies the repo with installs linked, and removes exact text once", () => {
    const src = mkdtempSync(path.join(tmpdir(), "ce-src-"));
    mkdirSync(path.join(src, "node_modules", "dep"), { recursive: true });
    mkdirSync(path.join(src, ".git"));
    writeFileSync(path.join(src, "prompt.txt"), "keep\nRULE: never X\nkeep\n");
    const copy = copyRepo(src);
    expect(lstatSync(path.join(copy, "node_modules")).isSymbolicLink()).toBe(true);
    expect(existsSync(path.join(copy, ".git"))).toBe(false);
    removeText(copy, "prompt.txt", "RULE: never X\n");
    expect(readFileSync(path.join(copy, "prompt.txt"), "utf8")).toBe("keep\nkeep\n");
    expect(readFileSync(path.join(src, "prompt.txt"), "utf8")).toContain("RULE");
    expect(() => removeText(copy, "prompt.txt", "keep")).toThrow(/more than once/);
    expect(() => removeText(copy, "prompt.txt", "absent")).toThrow(/isn't in/);
  });
});

describe("Python repos", () => {
  it("can import the repo's own package without sys.path tricks", async () => {
    const ctx: any = { profile: { id: "p" }, state: {}, record: () => {} };
    const s = spawnSession(ctx, ["python3", "evals/run_agent.py"], { cwd: path.resolve("test/fixtures/pyrepo") });
    expect(await s.send("hi")).toBe("mypkg says hi");
    await s.close!();
  });
});

describe("cost", () => {
  it("adds up create-evals' own token usage", async () => {
    const real = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ model: "claude-sonnet-5-5", stop_reason: "end_turn", usage: { input_tokens: 1_000_000, output_tokens: 100_000 }, content: [{ type: "text", text: '{"message":"hi","done":true}' }] }))) as any;
    restore = () => (globalThis.fetch = real);
    for (const k of Object.keys(usage)) delete usage[k];
    process.env.ANTHROPIC_API_KEY ??= "test";
    await converse(defineAgent({ name: "a", description: "", start: () => ({ send: async () => "ok" }) }), { id: "p", persona: "x" }, { userModel: "claude-sonnet-5-5" });
    // $2/M input + $10/M output on Sonnet 5.5.
    expect(usageLine()).toBe("create-evals model calls: 1, 1.1M tokens, about $3.00 (your agent's own calls not included)");
  });
});

// End to end through the built CLI, on a two-agent function binding: no model needed.
describe("CLI on a pipeline of function agents", () => {
  const cli = path.resolve("dist/cli.js");
  const dir = mkdtempSync(path.join(tmpdir(), "ce-fn-"));
  cpSync("test/fixtures/fn", dir, { recursive: true });
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("imports real records, runs each through its agent, and shows answers that flip", () => {
    const imp = run("import", "records.csv", "--input-field", "payload", "--agent", "qualify");
    expect(imp.stdout).toContain("2 profiles from records.csv");
    const profiles = JSON.parse(readFileSync(path.join(dir, ".create-evals/profiles.json"), "utf8")).profiles;
    profiles.push({ id: "coin", agent: "flaky", input: {} });
    writeFileSync(path.join(dir, ".create-evals/profiles.json"), JSON.stringify({ profiles }));
    const r = run("run", "--repeat", "2");
    expect(r.status, r.stderr).toBe(0);
    const list = JSON.parse(run("list", "--json").stdout);
    const dd = list.runs.find((x: any) => x.profile === "real-datadog-com");
    expect(dd).toMatchObject({ agent: "qualify", input: { domain: "datadog.com", sellsAgents: true }, output: { qualified: true } });
    expect(list.variance).toEqual([expect.objectContaining({ agent: "flaky", profile: "coin", runs: 2 })]);
    expect(run("list").stdout).toContain("Same input, different decisions: 1 input(s)");
  });

  it("checks every agent without warning about end state on JSON replies", () => {
    const r = run("check");
    expect(r.stdout).toContain("✔ qualify runs");
    expect(r.stdout).not.toContain("no end state");
  });

  it("runs tests with an input shorthand, reports pending ones apart, and writes a report", () => {
    const r = run("test", "--report", "report.json");
    expect(r.stdout).toContain("✔ agent seller qualifies");
    expect(r.stdout).toContain("◌ roundup field exists (pending: triage doesn't output a roundup yet)");
    expect(r.stdout).toContain("1 of 1 pass. 1 pending.");
    expect(JSON.parse(readFileSync(path.join(dir, "report.json"), "utf8")).map((t: any) => [t.name, t.passed])).toEqual([["agent seller qualifies", true], ["roundup field exists", false]]);
  });

  it("ablate: a test that guards a prompt rule fails once the rule is gone", () => {
    const r = run("ablate", "--test", "agent seller", "--remove", "RULE: companies that sell agents qualify.\n", "--in", "src/prompt.txt", "--runs", "1");
    expect(r.stdout).toContain("✔ agent seller qualifies: has teeth");
    expect(readFileSync(path.join(dir, "src/prompt.txt"), "utf8")).toContain("RULE");
    writeFileSync(path.join(dir, "rule.txt"), "You qualify accounts.\n");
    const weak = run("ablate", "--test", "agent seller", "--remove-file", "rule.txt", "--in", "src/prompt.txt", "--runs", "1");
    expect(weak.stdout).toContain("✖ agent seller qualifies: no teeth");
  });
});


describe("init in a Python repo", () => {
  it("scaffolds the Python runner next to the binding", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ce-init-py-"));
    writeFileSync(path.join(dir, "pyproject.toml"), "");
    const r = spawnSync(process.execPath, [path.resolve("dist/cli.js"), "init", "--function"], { cwd: dir, encoding: "utf8" });
    expect(r.stdout).toContain("wrote evals/run_agent.py");
    expect(readFileSync(path.join(dir, "evals/agent.ts"), "utf8")).toContain('spawnSession(ctx, ["python3", "evals/run_agent.py"]');
    expect(spawnSync("python3", ["-c", "import ast,sys; ast.parse(open(sys.argv[1]).read())", path.join(dir, "evals/run_agent.py")]).status).toBe(0);
  });
});

describe("import from stdin", () => {
  it("takes JSONL piped from a converter script", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ce-stdin-"));
    const r = spawnSync(process.execPath, [path.resolve("dist/cli.js"), "import", "-", "--agent", "triage"], { cwd: dir, encoding: "utf8", input: '{"id": "a", "x": 1}\n{"id": "b", "x": 2}\n' });
    expect(r.stdout).toContain("2 profiles from stdin");
    expect(JSON.parse(readFileSync(path.join(dir, ".create-evals/profiles.json"), "utf8")).profiles.map((p: any) => p.id)).toEqual(["real-a", "real-b"]);
  });
});
