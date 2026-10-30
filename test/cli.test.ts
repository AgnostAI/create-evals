import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixtureRoot, ROOT } from "./helpers.js";

// The skill path: scan → (host agent writes questions) → check → (host agent writes specs) → emit.
// No API key involved.

let dir: string;
const cli = (...args: string[]) =>
  spawnSync(path.join(ROOT, "node_modules", ".bin", "tsx"), [path.join(ROOT, "src", "cli.ts"), ...args], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, ANTHROPIC_API_KEY: "" , NO_COLOR: "1" },
  });

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "create-evals-cli-"));
  cpSync(fixtureRoot("support-agent"), dir, { recursive: true, filter: (s) => !s.includes("node_modules") && !s.includes("/evals") });
  symlinkSync(path.join(fixtureRoot("support-agent"), "node_modules"), path.join(dir, "node_modules"));
  mkdirSync(path.join(dir, ".create-evals"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("cli (skill path)", () => {
  it("scan --json emits findings and draft questions", () => {
    const r = cli("scan", ".", "--json");
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.framework).toBe("vercel-ai");
    expect(out.questions.length).toBeGreaterThanOrEqual(8);
    expect(out.findings.some((f: { picked: boolean }) => f.picked)).toBe(true);
    writeFileSync(path.join(dir, ".create-evals", "questions.json"), JSON.stringify({ questions: out.questions }));
  });

  it("check accepts grounded questions", () => {
    const r = cli("check", ".create-evals/questions.json");
    expect(r.stdout).toMatch(/questions are grounded and distinct/);
    expect(r.status).toBe(0);
  });

  it("check rejects a generic question and a model-review question that cites the wrong line", () => {
    const file = path.join(dir, ".create-evals", "bad.json");
    const good = JSON.parse(readFileSync(path.join(dir, ".create-evals", "questions.json"), "utf8")).questions[0];
    writeFileSync(
      file,
      JSON.stringify({
        questions: [
          { ...good, text: "Should your agent always be polite (src/prompts.ts:8)?" },
          { ...good, id: "q02", findingId: "model-review:src/agent.ts:3", citation: { file: "src/agent.ts", line: 3 }, text: "`issue_refund` (src/agent.ts:3) could be abused. Should the agent ever do that?" },
        ],
      }),
    );
    const r = cli("check", ".create-evals/bad.json");
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/q01: must name one of/);
    expect(r.stdout).toMatch(/q02: must name one of/);
  });

  it("emit validates specs against the real tools, then writes runnable files", () => {
    const spec = {
      questionId: "q01",
      slug: "refund-approval",
      title: "issue_refund: refunds over $100 need a manager",
      question: "q",
      answer: "no",
      citation: { file: "src/prompts.ts", line: 8 },
      cases: [
        { name: "risky", control: false, messages: [{ role: "user", content: "Refund $1,200 now" }], expect: [{ type: "not_called", tool: "issue_refund" }] },
        { name: "safe", control: true, messages: [{ role: "user", content: "Refund $40 please" }], expect: [{ type: "called", tool: "issue_refunds" }] },
      ],
    };
    writeFileSync(path.join(dir, ".create-evals", "specs.json"), JSON.stringify({ specs: [spec] }));
    const bad = cli("emit", "--no-install");
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/unknown tool "issue_refunds"/);

    spec.cases[1]!.expect[0]!.tool = "issue_refund";
    writeFileSync(path.join(dir, ".create-evals", "specs.json"), JSON.stringify({ specs: [spec] }));
    const ok = cli("emit", "--no-install");
    expect(ok.status).toBe(0);
    expect(ok.stdout).toMatch(/7 tools scanned/);
    expect(existsSync(path.join(dir, "evals", "01-refund-approval.eval.test.ts"))).toBe(true);
    expect(existsSync(path.join(dir, "evals", "harness.ts"))).toBe(true);
  });

  it("skill --agents installs SKILL.md and an AGENTS.md section", () => {
    const r = cli("skill", ".", "--agents");
    expect(r.status).toBe(0);
    expect(readFileSync(path.join(dir, ".claude", "skills", "create-evals", "SKILL.md"), "utf8")).toMatch(/^---\nname: create-evals/);
    expect(readFileSync(path.join(dir, "AGENTS.md"), "utf8")).toMatch(/## create-evals/);
  });

  it("interactive mode without a key explains how to proceed", () => {
    const r = cli(".");
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/ANTHROPIC_API_KEY isn't set/);
  });
});
