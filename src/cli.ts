#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as p from "@clack/prompts";
import pc from "picocolors";
import type { AnsweredQuestion, EvalSpec, Finding, Question } from "./core/types.js";
import { emit, emitHarness } from "./emit/index.js";
import { HarnessError } from "./emit/harness.js";
import { EvalSpecFileSchema, validateSpec } from "./evals/spec.js";
import { getLLM, LLMSetupError, pool } from "./llm/provider.js";
import { polishQuestions, proposeFindings } from "./llm/questions.js";
import { writeSpec } from "./llm/specs.js";
import { adhocFinding, analyze, QUESTION_COUNT, unguardedTools, workspace } from "./pipeline.js";
import { AGENT_MAP_PATH, AgentMapSchema, verifyAgentMap } from "./core/agent-map.js";
import { templateQuestion } from "./questions/templates.js";
import { validateQuestions } from "./questions/validate.js";
import { AGNOST_LINE, renderCard } from "./report/card.js";
import { RULE_LABELS } from "./risk/rules.js";
import { ScanError } from "./scan/index.js";

const VERSION = "0.1.0";
const FRAMEWORK_NAMES = {
  "vercel-ai": "Vercel AI SDK",
  "openai-agents": "OpenAI Agents SDK",
  mastra: "Mastra",
  "openai-sdk": "OpenAI SDK",
  "anthropic-sdk": "Anthropic SDK",
  custom: "Custom agent",
} as const;

const HELP = `${pc.bold("create-evals")} — reads your agent's code, asks 10 yes/no questions, writes 10 runnable evals.

${pc.bold("Usage")}
  npx create-evals [dir]              interactive: scan → 10 questions → 10 evals
  npx create-evals scan [dir] --json  findings + draft questions (no API key needed)
  npx create-evals check [file]       validate the agent map or questions (default .create-evals/questions.json)
  npx create-evals emit [file]        validate eval specs and write tests (default .create-evals/specs.json)
  npx create-evals harness            write evals/harness.ts now (to wire it before writing specs)
  npx create-evals verify             typecheck the evals, check the harness is wired and the test runner picks them up
  npx create-evals try [--runs N] [--verbose]
                                      run the evals N times; each test shows as passed, failed, or flaky,
                                      with why (exits 1 on any failure or flake)
  npx create-evals skill [--agents]   install the skill into .claude/skills (and AGENTS.md with --agents)

${pc.bold("Options")}
  --model <provider:model>   default anthropic:claude-opus-5-5 (any installed @ai-sdk/* provider)
  --answers <file|yes|no>    answer non-interactively (JSON {"q01":"no",...}, or one answer for all)
  --out <dir>                where to write evals (default evals)
  --no-install               don't install missing dev dependencies
  --force                    overwrite evals/harness.ts and evals/judge.ts
`;

interface Flags {
  _: string[];
  json?: boolean;
  model?: string;
  runs?: string;
  answers?: string;
  out?: string;
  install: boolean;
  force?: boolean;
  agents?: boolean;
  verbose?: boolean;
  help?: boolean;
  version?: boolean;
}

function parseArgs(argv: string[]): Flags {
  const flags: Flags = { _: [], install: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--json") flags.json = true;
    else if (a === "--no-install") flags.install = false;
    else if (a === "--force") flags.force = true;
    else if (a === "--agents") flags.agents = true;
    else if (a === "--verbose") flags.verbose = true;
    else if (a === "--help" || a === "-h") flags.help = true;
    else if (a === "--version" || a === "-v") flags.version = true;
    else if (a === "--model" || a === "--answers" || a === "--out" || a === "--runs") flags[a.slice(2) as "model" | "answers" | "out" | "runs"] = argv[++i];
    else if (a.startsWith("--")) fail(`Unknown option ${a}. See --help.`);
    else flags._.push(a);
  }
  return flags;
}

function fail(message: string): never {
  console.error(`${pc.red("✖")} ${message}`);
  process.exit(1);
}

const highlight = (s: string) => s.replace(/`([^`]+)`/g, (_, c: string) => pc.cyan(c)).replace(/\(([\w./-]+:\d+)\)/g, (_, c: string) => pc.dim(`(${c})`));

/** Word-wrap plain text to the terminal (clack doesn't), before any color codes are added. */
function wrap(text: string, width = Math.min(process.stdout.columns || Number(process.env.COLUMNS) || 100, 110) - 6): string {
  const lines: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(" ")) {
      if (line && (line + " " + word).length > width) {
        lines.push(line);
        line = word;
      } else line = line ? `${line} ${word}` : word;
    }
    lines.push(line);
  }
  return lines.join("\n");
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) return console.log(HELP);
  if (flags.version) return console.log(VERSION);

  const [cmd, ...rest] = flags._;
  if (cmd === "scan") return cmdScan(path.resolve(rest[0] ?? "."), flags);
  if (cmd === "check") return cmdCheck(path.resolve("."), rest[0] ?? ".create-evals/questions.json");
  if (cmd === "emit") return cmdEmit(path.resolve("."), rest[0] ?? ".create-evals/specs.json", flags);
  if (cmd === "skill") return cmdSkill(path.resolve(rest[0] ?? "."), flags);
  if (cmd === "verify") return cmdVerify(path.resolve("."), flags);
  if (cmd === "harness") return cmdHarness(path.resolve("."), flags);
  if (cmd === "try") return cmdTry(path.resolve("."), flags);
  return cmdInteractive(path.resolve(cmd ?? "."), flags);
}

// ---------------------------------------------------------------------------

function cmdScan(root: string, flags: Flags) {
  const w = workspace(root);
  const a = w;
  const out = {
    recognized: !w.scanError,
    ...(w.scanError
      ? {
          note:
            "The scanner didn't recognize this agent's shape. That's fine: read the code yourself and write .create-evals/agent.json (see SKILL.md). Everything below that isn't empty is still useful.",
          scanError: w.scanError,
        }
      : {}),
    agentMap: w.hasMap ? (w.mapProblems.length ? { problems: w.mapProblems } : "ok") : "none yet",
    framework: a.model.framework,
    runner: a.model.runner ?? "none (vitest will be added)",
    providerEnv: a.model.providerEnv,
    agents: a.model.agents.map((x) => ({ name: x.name, at: `${x.loc.file}:${x.loc.line}`, tools: x.toolNames, entry: x.entry })),
    tools: a.model.tools.map((t) => ({ name: t.name, at: `${t.loc.file}:${t.loc.line}`, params: t.params.map((p) => `${p.name}: ${p.schema}`), approval: t.hasApproval })),
    prompts: a.model.prompts.map((pr) => ({ file: pr.file, lines: pr.lines.map((l) => `${l.line}: ${l.text}`) })),
    stats: { tools: a.model.tools.length, unguarded: unguardedTools(a.findings), findings: a.findings.length },
    findings: a.findings.map((f) => ({ ...f, picked: a.picked.includes(f) })),
    questions: a.questions,
  };
  if (flags.json) return console.log(JSON.stringify(out, null, 2));
  if (w.scanError) fail(w.scanError);

  console.log(`${pc.bold(FRAMEWORK_NAMES[a.model.framework])} · ${a.model.tools.length} tools · ${a.findings.length} findings\n`);
  for (const q of a.questions) console.log(`${pc.dim(q.id)} ${highlight(wrap(q.text))}\n`);
}

function cmdCheck(root: string, file: string) {
  const data = readJsonFile<Record<string, unknown>>(file);
  if ("entry" in data || "kind" in data) return checkMap(root, file);
  const w = workspace(root);
  const questions = (data.questions ?? []) as (Question & { answer?: string })[];
  const findings: Finding[] = [...w.findings];
  for (const q of questions) {
    if (!findings.some((f) => f.id === q.findingId)) {
      const adhoc = adhocFinding(root, q);
      if (adhoc) findings.push(adhoc);
    }
  }
  const issues = validateQuestions(root, questions, findings);
  if (questions.length !== QUESTION_COUNT) console.log(pc.yellow(`! ${questions.length} questions (aim for ${QUESTION_COUNT}; fewer is fine if the repo is small)`));
  if (!issues.length) return console.log(pc.green(`✔ ${questions.length} questions are grounded and distinct`));
  for (const i of issues) console.log(`${pc.red("✖")} ${i.questionId}: ${i.problem}`);
  process.exit(1);
}

function checkMap(root: string, file: string) {
  const parsed = AgentMapSchema.safeParse(readJsonFile(file));
  if (!parsed.success) fail(`${file} doesn't match the agent map format:\n${parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")}`);
  const problems = verifyAgentMap(root, parsed.data);
  if (problems.length) {
    for (const p of problems) console.log(`${pc.red("✖")} ${p}`);
    process.exit(1);
  }
  const m = parsed.data;
  console.log(pc.green(`✔ agent map checks out: ${m.tools.length} tools, ${m.functions.length} functions, ${m.prompts.length} prompt lines, all locations verified`));
}

function cmdEmit(root: string, file: string, flags: Flags) {
  const w = workspace(root);
  if (w.mapProblems.length) fail(`Fix ${AGENT_MAP_PATH} first:\n${w.mapProblems.map((p) => `  ${p}`).join("\n")}`);
  if (w.scanError && !w.hasMap) {
    fail(`The scanner couldn't recognize this agent, so write ${AGENT_MAP_PATH} first (see SKILL.md step 1).\n\n${w.scanError}`);
  }
  const parsed = EvalSpecFileSchema.safeParse(readJsonFile(file));
  if (!parsed.success) fail(`${file} doesn't match the spec format:\n${parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")}`);
  const specs = parsed.data.specs as EvalSpec[];
  const problems = specs.flatMap((s) => validateSpec(s, w.model).map((m) => `${s.questionId}: ${m}`));
  if (problems.length) fail(`Fix these and re-run:\n${problems.map((m) => `  ${m}`).join("\n")}`);
  const result = writeEvals(w.model, specs, flags);
  const harness = readFileSync(path.join(root, result.dir, "harness.ts"), "utf8");
  if (harness.includes("create-evals: wire up")) {
    p.log.warn(`evals/harness.ts needs one edit: implement callYourAgent() (${w.hasMap ? "your agent map's entry.how says how to call it" : "see the comment in the file"}). Then run \`create-evals verify\`.`);
  }
  printFinish(w, result.files.filter((f) => f.endsWith(".eval.test.ts")), w.model.providerEnv);
}

/**
 * Run the generated evals (optionally several times) and summarize each test as passed, failed, or
 * flaky, with the first line of why. This is the calibration loop: a failing control usually means
 * a badly written eval; a failing risk case is usually a real catch.
 */
function cmdTry(root: string, flags: Flags) {
  const w = workspace(root);
  const rel = flags.out ?? "evals";
  if (!existsSync(path.join(root, rel))) fail(`No ${rel}/ yet. Run \`create-evals emit\` first.`);
  const required = w.model.requiredEnv ?? [w.model.providerEnv];
  const missing = required.filter((v) => !process.env[v]);
  if (missing.length) fail(`Set ${missing.join(", ")} first; without it every eval is skipped.`);

  const runs = Math.max(1, Number(flags.runs ?? 1));
  const runner = w.model.runner ?? "vitest";
  const report = path.join(root, ".create-evals", "try.json");
  mkdirSync(path.dirname(report), { recursive: true });
  const results = new Map<string, { status: string[]; message?: string; full?: string; file: string }>();

  for (let i = 0; i < runs; i++) {
    // Coding agents read this output; spinners only make sense in a real terminal.
    const s = process.stdout.isTTY ? p.spinner() : { start: (m: string) => console.log(m), stop: (m: string) => console.log(m) };
    s.start(`Running the evals${runs > 1 ? ` (${i + 1}/${runs})` : ""}`);
    const bin = path.join(root, "node_modules", ".bin", runner);
    const args = runner === "jest" ? [rel, "--json", `--outputFile=${report}`] : ["run", rel, "--reporter=json", `--outputFile=${report}`];
    spawnSync(existsSync(bin) ? bin : "npx", existsSync(bin) ? args : [runner, ...args], { cwd: root, encoding: "utf8", stdio: "ignore" });
    s.stop(`Run ${i + 1} done`);
    if (!existsSync(report)) fail(`The test runner didn't produce a report. Run \`create-evals verify\` and try again.`);
    const json = JSON.parse(readFileSync(report, "utf8")) as { testResults: { name: string; assertionResults: { fullName: string; status: string; failureMessages?: string[] }[] }[] };
    for (const file of json.testResults) {
      for (const t of file.assertionResults) {
        const entry = results.get(t.fullName) ?? { status: [], file: path.relative(root, file.name) };
        entry.status.push(t.status);
        if (t.status === "failed" && !entry.message) {
          entry.message = firstLine(t.failureMessages?.join("\n") ?? "", root, rel);
          entry.full = (t.failureMessages ?? []).join("\n").replace(/\x1b\[[0-9;]*m/g, "").split("\n").filter((l) => !/^\s+at /.test(l)).join("\n");
        }
        results.set(t.fullName, entry);
      }
    }
  }

  let failed = 0;
  let flaky = 0;
  const byFile = new Map<string, string[]>();
  for (const [name, r] of results) {
    const passes = r.status.filter((x) => x === "passed").length;
    const skipped = r.status.every((x) => x === "skipped" || x === "pending");
    const mark = skipped ? pc.dim("–") : passes === r.status.length ? pc.green("✔") : passes === 0 ? pc.red("✖") : pc.yellow("~");
    if (!skipped && passes === 0) failed++;
    else if (!skipped && passes < r.status.length) flaky++;
    const detail = r.message && passes < r.status.length ? (flags.verbose && r.full ? `\n${indentText(r.full, 6)}` : `\n      ${pc.dim(r.message)}`) : "";
    const line = `  ${mark} ${name.replace(/^.*? > /, "")}${runs > 1 && !skipped ? pc.dim(` (${passes}/${r.status.length})`) : ""}${detail}`;
    byFile.set(r.file, [...(byFile.get(r.file) ?? []), line]);
  }
  for (const [file, lines] of byFile) console.log(`${pc.bold(file)}\n${lines.join("\n")}`);
  const total = results.size;
  console.log(`\n${total - failed - flaky}/${total} passed${failed ? `, ${pc.red(`${failed} failed`)}` : ""}${flaky ? `, ${pc.yellow(`${flaky} flaky`)}` : ""}${runs > 1 ? ` over ${runs} runs` : ""}`);
  if (failed || flaky) {
    console.log(
      pc.dim(
        "For each failure: a failing control or an over-broad judge is usually a badly written eval (fix the spec and re-emit); a failing risk case is usually a real catch (tell the developer). Flaky never-cases are worth a `repeat`. Add --verbose for each failure's full transcript.",
      ),
    );
    process.exit(1);
  }
}

function indentText(text: string, n: number): string {
  return text.split("\n").map((l) => " ".repeat(n) + l).join("\n");
}

function firstLine(message: string, root = "", rel = "evals"): string {
  const clean = message.replace(/\x1b\[[0-9;]*m/g, "");
  const judge = /failed because: (.*)/.exec(clean)?.[1];
  // Assertion messages start with the transcript; the verdict is the last "expected …" line.
  const expected = [...clean.matchAll(/(expected [^\n]*)/g)].at(-1)?.[1];
  const other = /(?:Error|AssertionError): ([^\n]*)/.exec(clean)?.[1];
  let text = judge ? `judge: ${judge}` : expected ?? other ?? clean.split("\n")[0] ?? "";
  // Show which check failed: the assertion's own source line, from the stack.
  const at = new RegExp(`${rel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/([^:\\s)]+\\.eval\\.test\\.[cm]?[jt]s):(\\d+):\\d+`).exec(clean);
  if (!judge && at && root) {
    const src = readFileSync(path.join(root, rel, at[1]!), "utf8").split("\n")[Number(at[2]) - 1]?.trim();
    if (src) text = `${src.replace(/, run\.transcript\(\)/, "")}  →  ${text}`;
  }
  return text.length > 220 ? text.slice(0, 220) + "…" : text;
}

/** Write evals/harness.ts now, so it can be wired (or extended with wrappers) before specs exist. */
function cmdHarness(root: string, flags: Flags) {
  const w = workspace(root);
  if (w.mapProblems.length) fail(`Fix ${AGENT_MAP_PATH} first:\n${w.mapProblems.map((p) => `  ${p}`).join("\n")}`);
  const r = emitHarness(w.model, { outDir: flags.out, force: flags.force });
  console.log(r.kept ? `${pc.dim("•")} ${r.file} already exists (use --force to regenerate)` : `${pc.green("✔")} wrote ${r.file}`);
}

/**
 * Typecheck the generated evals against the repo's own TypeScript config and make sure the
 * harness is wired, so the host agent can iterate until the evals actually load.
 */
function cmdVerify(root: string, flags: Flags) {
  const dir = path.join(root, flags.out ?? "evals");
  if (!existsSync(dir)) fail(`No ${flags.out ?? "evals"}/ directory yet. Run \`create-evals emit\` first.`);
  let ok = true;
  const harness = path.join(dir, "harness.ts");
  if (existsSync(harness) && readFileSync(harness, "utf8").includes("create-evals: wire up")) {
    console.log(`${pc.red("✖")} evals/harness.ts: callYourAgent() still throws. Make it call your agent (see the comment above it).`);
    ok = false;
  }

  const local = path.join(root, "node_modules", ".bin", "tsc");
  if (!existsSync(local)) {
    console.log(pc.yellow(`! typescript isn't installed in this repo; skipping the typecheck (\`npm i -D typescript\` to enable)`));
  } else {
    mkdirSync(path.join(root, ".create-evals"), { recursive: true });
    const cfg = path.join(root, ".create-evals", "tsconfig.verify.json");
    const base = existsSync(path.join(root, "tsconfig.json")) ? { extends: "../tsconfig.json" } : { compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", target: "ES2022", strict: true } };
    writeFileSync(
      cfg,
      JSON.stringify({ ...base, compilerOptions: { ...("compilerOptions" in base ? base.compilerOptions : {}), noEmit: true, skipLibCheck: true, rootDir: ".." }, include: [`../${flags.out ?? "evals"}/**/*.ts`] }, null, 2),
    );
    const r = spawnSync(local, ["-p", cfg], { cwd: root, encoding: "utf8" });
    const errors = (r.stdout + r.stderr).split("\n").filter((l) => /error TS/.test(l));
    const mine = errors.filter((l) => l.includes(`${flags.out ?? "evals"}/`));
    if (mine.length) {
      ok = false;
      console.log(`${pc.red("✖")} ${mine.length} type error${mine.length === 1 ? "" : "s"} in the evals:`);
      for (const e of mine.slice(0, 20)) console.log(`  ${e.trim()}`);
    } else {
      console.log(`${pc.green("✔")} evals typecheck against your code${errors.length ? pc.dim(` (${errors.length} pre-existing errors elsewhere ignored)`) : ""}`);
    }
  }
  const w = workspace(root);
  const collects = runnerCollectsEvals(root, w.model.runner ?? "vitest");
  if (!collects.ok) {
    console.log(`${pc.red("✖")} your test config won't pick up the evals: ${collects.hint}`);
    ok = false;
  }
  if (!ok) process.exit(1);
  const required = w.model.requiredEnv ?? [w.model.providerEnv];
  const judge = existsSync(path.join(dir, "judge.ts"));
  const keys = [...required];
  if (judge && !keys.includes("ANTHROPIC_API_KEY")) keys.push("ANTHROPIC_API_KEY (for the judge)");
  console.log(pc.green(`✔ ready: run the tests. They call your real model${keys.length ? `; set ${keys.join(" and ")}` : ""} (without them they skip).`));
}

function cmdSkill(root: string, flags: Flags) {
  const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const skillSrc = path.join(pkgDir, "skill", "create-evals", "SKILL.md");
  const target = path.join(root, ".claude", "skills", "create-evals", "SKILL.md");
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(skillSrc, target);
  console.log(`${pc.green("✔")} Installed ${path.relative(process.cwd(), target)} — ask Claude Code to "create evals for this agent".`);
  if (flags.agents) {
    const agentsFile = path.join(root, "AGENTS.md");
    const section = readFileSync(path.join(pkgDir, "skill", "AGENTS.md"), "utf8");
    const current = existsSync(agentsFile) ? readFileSync(agentsFile, "utf8") : "";
    if (current.includes("## create-evals")) console.log(`${pc.dim("•")} AGENTS.md already has a create-evals section`);
    else {
      writeFileSync(agentsFile, (current ? current.trimEnd() + "\n\n" : "") + section);
      console.log(`${pc.green("✔")} Added a create-evals section to AGENTS.md (Codex, Cursor, and other agents read it)`);
    }
  }
}

// ---------------------------------------------------------------------------

async function cmdInteractive(root: string, flags: Flags) {
  console.log();
  p.intro(pc.bgCyan(pc.black(" create-evals ")));

  const s = p.spinner();
  s.start("Reading your agent");
  let a;
  try {
    a = analyze(root, 14);
  } catch (e) {
    s.error("Couldn't read the agent");
    if (e instanceof ScanError) fail(e.message);
    throw e;
  }
  const promptLines = a.model.prompts.reduce((n, pr) => n + pr.lines.length, 0);
  const fnCount = a.model.agents.filter((x) => x.entry?.kind === "llm-function").length;
  const shape = a.model.tools.length ? `${a.model.tools.length} tools` : `${fnCount} LLM function${fnCount === 1 ? "" : "s"}`;
  s.stop(
    `${pc.bold(FRAMEWORK_NAMES[a.model.framework])} · ${shape} · ${a.model.prompts.length} system prompt${a.model.prompts.length === 1 ? "" : "s"} (${promptLines} lines) · ${a.model.runner ?? "no test runner yet"}`,
  );

  let llm;
  try {
    llm = await getLLM(flags.model);
  } catch (e) {
    if (e instanceof LLMSetupError) fail(e.message);
    throw e;
  }

  s.start(`Ranking ${a.findings.length} risks and writing questions`);
  let picked = a.picked.slice(0, QUESTION_COUNT);
  if (picked.length < QUESTION_COUNT) {
    const covered = picked.map((f) => templateQuestion(f, 0).text);
    picked = [...picked, ...(await proposeFindings(llm, a.model, a.findings, QUESTION_COUNT - picked.length, covered))];
  }
  const allFindings = [...a.findings, ...picked.filter((f) => !a.findings.includes(f))];
  const questions = await polishQuestions(llm, a.model, picked);
  s.stop(`${questions.length} questions, each tied to a line in your code`);

  p.note(
    `Answer ${pc.bold("yes")} if the agent is allowed to do it, ${pc.bold("no")} if it needs a guardrail.\nEach answer becomes one eval.`,
    "How this works",
  );

  const scripted = loadAnswers(flags.answers);
  const answered: AnsweredQuestion[] = [];
  for (const [i, q] of questions.entries()) {
    const f = picked.find((x) => x.id === q.findingId);
    const label = `${pc.dim(`${i + 1}/${questions.length}`)} ${pc.dim(f ? RULE_LABELS[f.rule] : "")}\n${highlight(wrap(q.text))}`;
    let yes: boolean;
    const preset = scripted?.(q.id);
    if (preset !== undefined) {
      yes = preset;
      p.log.message(`${label}\n${pc.dim("→")} ${yes ? "yes" : "no"}`);
    } else {
      const r = await p.confirm({ message: label, active: "yes", inactive: "no", initialValue: false });
      if (p.isCancel(r)) {
        p.cancel("Stopped. Nothing was written.");
        process.exit(0);
      }
      yes = r;
    }
    answered.push({ ...q, answer: yes ? "yes" : "no" });
  }

  s.start(`Writing ${answered.length} evals`);
  let done = 0;
  const results = await pool(answered, 5, async (q) => {
    try {
      const spec = await writeSpec(llm, a.model, q, allFindings.find((f) => f.id === q.findingId), answered);
      s.message(`Writing evals (${++done}/${answered.length})`);
      return spec;
    } catch (e) {
      s.message(`Writing evals (${++done}/${answered.length})`);
      return e instanceof Error ? e : new Error(String(e));
    }
  });
  const specs = results.filter((r): r is EvalSpec => !(r instanceof Error));
  const failed = results.filter((r): r is Error => r instanceof Error);
  s.stop(`Wrote ${specs.length} eval specs${failed.length ? pc.yellow(` (${failed.length} failed: ${failed.map((f) => f.message).join("; ")})`) : ""}`);
  if (!specs.length) fail("No evals could be written.");

  const result = writeEvals(a.model, specs, flags, answered);
  printFinish({ ...a, findings: allFindings }, result.files.filter((f) => f.endsWith(".eval.test.ts")), a.model.providerEnv);
}

function writeEvals(model: ReturnType<typeof analyze>["model"], specs: EvalSpec[], flags: Flags, questions?: AnsweredQuestion[]) {
  let result;
  try {
    result = emit(model, specs, { outDir: flags.out, force: flags.force, questions });
  } catch (e) {
    if (e instanceof HarnessError) fail(e.message);
    throw e;
  }
  if (result.kept.length) p.log.info(`Kept your edited ${result.kept.join(", ")} (use --force to regenerate)`);
  if (result.addedTestScript) p.log.info(`Added a ${pc.cyan('"test"')} script to package.json`);
  if (result.addedDeps.length) {
    if (flags.install) {
      const s = p.spinner();
      s.start(`Installing ${result.addedDeps.join(", ")}`);
      const r = spawnSync(model.packageManager, ["install"], { cwd: model.root, encoding: "utf8", shell: process.platform === "win32" });
      if (r.status === 0) s.stop(`Installed ${result.addedDeps.join(", ")}`);
      else if ((r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
        s.error(`This repo uses ${model.packageManager} (from its lockfile), but ${model.packageManager} isn't installed. Added ${result.addedDeps.join(", ")} to package.json; run \`${model.packageManager} install\`.`);
      } else s.error(`\`${model.packageManager} install\` failed; run it yourself to finish adding ${result.addedDeps.join(", ")}`);
    } else {
      p.log.info(`Added ${result.addedDeps.join(", ")} to devDependencies. Run \`${model.packageManager} install\`.`);
    }
  }
  return result;
}

function printFinish(a: { model: ReturnType<typeof analyze>["model"]; findings: Finding[] }, files: string[], envVar: string) {
  const collects = runnerCollectsEvals(a.model.root, a.model.runner ?? "vitest");
  const base = a.model.packageManager === "npm" ? "npm test" : `${a.model.packageManager} test`;
  const runCommand = collects.ok ? base : `${base}  (first add evals/ to your test config: ${collects.hint})`;
  // Wrappers the host agent wrote in evals/ aren't the agent; don't count them twice.
  const fns = a.model.agents.filter((x) => x.entry?.kind === "llm-function" && !x.loc.file.startsWith("evals/"));
  const required = a.model.requiredEnv ?? [envVar];
  console.log();
  console.log(
    renderCard({
      tools: a.model.tools.length || fns.length,
      noun: a.model.tools.length ? "tools" : fns.length === 1 ? "LLM function" : "LLM functions",
      // Only the scanner's findings back the "no guardrails" number; in map mode, just report what was mapped.
      unguarded: a.findings.length ? unguardedTools(a.findings) : undefined,
      unguardedLabel: a.model.tools.length ? "had no guardrails" : unguardedTools(a.findings) === 1 ? "has prompt rules nothing enforces" : "have prompt rules nothing enforces",
      evals: files.length,
      files,
      runCommand,
      envVar: required.join(" + ") || "no key",
      hasKey: required.every((v) => Boolean(process.env[v])),
    }),
  );
  console.log(`\n${pc.dim(wrap(AGNOST_LINE, Math.min(process.stdout.columns || Number(process.env.COLUMNS) || 100, 110)))}\n`);
}

/** Does the repo's test config pick up evals/? A restrictive vitest/jest include silently skips them. */
function runnerCollectsEvals(root: string, runner: string): { ok: boolean; hint: string } {
  const configs = runner === "jest" ? ["jest.config.ts", "jest.config.js", "jest.config.mjs", "jest.config.cjs"] : ["vitest.config.ts", "vitest.config.mts", "vitest.config.js", "vitest.config.mjs", "vite.config.ts", "vite.config.js"];
  for (const name of configs) {
    const file = path.join(root, name);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    const key = runner === "jest" ? /(testMatch|roots)\s*:\s*\[([^\]]*)\]/ : /include\s*:\s*\[([^\]]*)\]/;
    const m = key.exec(text);
    if (!m) return { ok: true, hint: "" };
    const patterns = (m.at(-1) ?? "").match(/["'`]([^"'`]+)["'`]/g)?.map((x) => x.slice(1, -1)) ?? [];
    const ok = patterns.some((p) => p.includes("evals") || /^\*\*\//.test(p) || p === "<rootDir>");
    return { ok, hint: ok ? "" : `add "evals/**/*.eval.test.ts" to ${runner === "jest" ? "testMatch" : "test.include"} in ${name}` };
  }
  return { ok: true, hint: "" };
}
function loadAnswers(spec: string | undefined): ((id: string) => boolean | undefined) | undefined {
  if (!spec) return undefined;
  if (/^(y|yes|n|no)$/i.test(spec)) {
    const v = /^y/i.test(spec);
    return () => v;
  }
  const data = readJsonFile<Record<string, string | boolean>>(spec);
  return (id) => {
    const v = data[id];
    return v === undefined ? undefined : v === true || /^y/i.test(String(v));
  };
}

function readJsonFile<T = unknown>(file: string): T {
  if (!existsSync(file)) fail(`${file} not found`);
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch (e) {
    fail(`${file} isn't valid JSON: ${(e as Error).message}`);
  }
}

main().catch((e) => {
  if (e instanceof ScanError || e instanceof HarnessError || e instanceof LLMSetupError) fail(e.message);
  console.error(e);
  process.exit(1);
});
