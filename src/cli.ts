#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as p from "@clack/prompts";
import pc from "picocolors";
import type { AnsweredQuestion, EvalSpec, Finding, Question } from "./core/types.js";
import { emit } from "./emit/index.js";
import { HarnessError } from "./emit/harness.js";
import { EvalSpecFileSchema, validateSpec } from "./evals/spec.js";
import { getLLM, LLMSetupError, pool } from "./llm/provider.js";
import { polishQuestions, proposeFindings } from "./llm/questions.js";
import { writeSpec } from "./llm/specs.js";
import { adhocFinding, analyze, QUESTION_COUNT, unguardedTools } from "./pipeline.js";
import { templateQuestion } from "./questions/templates.js";
import { validateQuestions } from "./questions/validate.js";
import { AGNOST_LINE, renderCard } from "./report/card.js";
import { RULE_LABELS } from "./risk/rules.js";
import { ScanError } from "./scan/index.js";

const VERSION = "0.1.0";
const FRAMEWORK_NAMES = { "vercel-ai": "Vercel AI SDK", "openai-agents": "OpenAI Agents SDK", mastra: "Mastra" } as const;

const HELP = `${pc.bold("create-evals")} — reads your agent's code, asks 10 yes/no questions, writes 10 runnable evals.

${pc.bold("Usage")}
  npx create-evals [dir]              interactive: scan → 10 questions → 10 evals
  npx create-evals scan [dir] --json  findings + draft questions (no API key needed)
  npx create-evals check [file]       validate questions (default .create-evals/questions.json)
  npx create-evals emit [file]        validate eval specs and write tests (default .create-evals/specs.json)
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
  answers?: string;
  out?: string;
  install: boolean;
  force?: boolean;
  agents?: boolean;
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
    else if (a === "--help" || a === "-h") flags.help = true;
    else if (a === "--version" || a === "-v") flags.version = true;
    else if (a === "--model" || a === "--answers" || a === "--out") flags[a.slice(2) as "model" | "answers" | "out"] = argv[++i];
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
  return cmdInteractive(path.resolve(cmd ?? "."), flags);
}

// ---------------------------------------------------------------------------

function cmdScan(root: string, flags: Flags) {
  const a = analyze(root);
  const out = {
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

  console.log(`${pc.bold(FRAMEWORK_NAMES[a.model.framework])} · ${a.model.tools.length} tools · ${a.findings.length} findings\n`);
  for (const q of a.questions) console.log(`${pc.dim(q.id)} ${highlight(wrap(q.text))}\n`);
}

function cmdCheck(root: string, file: string) {
  const a = analyze(root);
  const data = readJsonFile<{ questions: (Question & { answer?: string })[] }>(file);
  const findings: Finding[] = [...a.findings];
  for (const q of data.questions) {
    if (!findings.some((f) => f.id === q.findingId)) {
      const adhoc = adhocFinding(root, q);
      if (adhoc) findings.push(adhoc);
    }
  }
  const issues = validateQuestions(root, data.questions, findings);
  if (data.questions.length !== QUESTION_COUNT) console.log(pc.yellow(`! ${data.questions.length} questions (aim for ${QUESTION_COUNT}; fewer is fine if the repo is small)`));
  if (!issues.length) return console.log(pc.green(`✔ ${data.questions.length} questions are grounded and distinct`));
  for (const i of issues) console.log(`${pc.red("✖")} ${i.questionId}: ${i.problem}`);
  process.exit(1);
}

function cmdEmit(root: string, file: string, flags: Flags) {
  const a = analyze(root);
  const parsed = EvalSpecFileSchema.safeParse(readJsonFile(file));
  if (!parsed.success) fail(`${file} doesn't match the spec format:\n${parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")}`);
  const specs = parsed.data.specs as EvalSpec[];
  const problems = specs.flatMap((s) => validateSpec(s, a.model).map((m) => `${s.questionId}: ${m}`));
  if (problems.length) fail(`Fix these and re-run:\n${problems.map((m) => `  ${m}`).join("\n")}`);
  const result = writeEvals(a.model, specs, flags);
  printFinish(a, result.files.filter((f) => f.endsWith(".eval.test.ts")), a.model.providerEnv);
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
  s.stop(
    `${pc.bold(FRAMEWORK_NAMES[a.model.framework])} · ${a.model.tools.length} tools · ${a.model.prompts.length} system prompt${a.model.prompts.length === 1 ? "" : "s"} (${promptLines} lines) · ${a.model.runner ?? "no test runner yet"}`,
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
      else s.error(`Install failed; run \`${model.packageManager} install\` yourself`);
    } else {
      p.log.info(`Added ${result.addedDeps.join(", ")} to devDependencies. Run \`${model.packageManager} install\`.`);
    }
  }
  return result;
}

function printFinish(a: { model: ReturnType<typeof analyze>["model"]; findings: Finding[] }, files: string[], envVar: string) {
  const runCommand = a.model.packageManager === "npm" ? "npm test" : `${a.model.packageManager} test`;
  console.log();
  console.log(
    renderCard({
      tools: a.model.tools.length,
      unguarded: unguardedTools(a.findings),
      evals: files.length,
      files,
      runCommand,
      envVar,
      hasKey: Boolean(process.env[envVar]),
    }),
  );
  console.log(`\n${pc.dim(wrap(AGNOST_LINE, Math.min(process.stdout.columns || Number(process.env.COLUMNS) || 100, 110)))}\n`);
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
  console.error(e);
  process.exit(1);
});
