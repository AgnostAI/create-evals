#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentDefinition } from "./agent.js";
import { DEFAULT_MODELS, keyFor } from "./llm.js";
import { CONFIG_PATH, DIR, loadAgent, loadConfig, prepare, readInstructions, type Config } from "./project.js";
import { group, review } from "./review.js";
import { converse, converseAll } from "./run.js";
import { blocked } from "./sandbox.js";
import { registered, setCurrentFile, type Registered } from "./scenario.js";
import { render } from "./trace.js";
import type { FailureMode, Profile, Trace } from "./types.js";

const VERSION = "0.1.1";
const tty = process.stdout.isTTY;
const c = (code: number) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const [bold, dim, red, green, yellow] = [c(1), c(2), c(31), c(32), c(33)];

const HELP = `${bold("create-evals")} ${VERSION}: find your agent's real failures and turn each one into a test.

${bold("Start here")}
  npx create-evals                  set up the skill, then open your coding agent and run /create-evals

${bold("Day to day")}
  create-evals find                 run simulated users, review every conversation, list what went wrong
  create-evals test                 run the tests in evals/ (--tier always in CI)

${bold("Building blocks")} (the skill uses these)
  init [--function]                 scaffold evals/agent.ts and ${CONFIG_PATH}
  check [--message m]               one short conversation, to prove the setup works
  run [--profiles f] [--only a,b] [--repeat n]
  review [--all]                    note what went wrong in each new trace
  group                             merge the notes into failure modes (${DIR}/failures.json)
  list | show <id> [--full] | status
  drop <id…> | reset                discard bad traces, or archive this round and start fresh
  test [files] [--runs n] [--tier always|usually] [--only text]

Options: --config <file>, --model <id> (review/group), --user-model <id>, --concurrency <n>
Docs: https://github.com/AgnostAI/create-evals`;

interface Flags {
  _: string[];
  [k: string]: string | boolean | string[];
}

const BOOLEAN_FLAGS = ["all", "help", "version", "full", "function"];

function parse(argv: string[]): Flags {
  const f: Flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-h") f.help = true;
    else if (!a.startsWith("--")) f._.push(a);
    else {
      const [name, inline] = a.slice(2).split(/=(.*)/s) as [string, string | undefined];
      if (BOOLEAN_FLAGS.includes(name)) f[name] = true;
      else f[name] = inline ?? argv[++i] ?? "";
    }
  }
  return f;
}

/** A positive integer flag, or the fallback. Anything else is a usage error. */
function count(f: Flags, name: string, fallback: number): number {
  if (f[name] === undefined) return fallback;
  const n = Number(f[name]);
  if (!Number.isInteger(n) || n < 1) fail(`--${name} must be a positive whole number, got "${f[name]}"`);
  return n;
}

function requireKey(modelId: string) {
  const name = keyFor(modelId);
  if (!process.env[name]) fail(`${name} isn't set (needed for ${modelId}). Set it in your shell or .env.`);
}

const root = process.cwd();
const dir = (...p: string[]) => path.join(root, DIR, ...p);
const tracesDir = (kind: "runs" | "tests" | "checks" = "runs") => dir({ runs: "traces", tests: "test-traces", checks: "check-traces" }[kind]);

function fail(msg: string): never {
  console.error(red(`✖ ${msg}`));
  process.exit(1);
}

function readJson<T>(file: string): T {
  if (!existsSync(file)) fail(`${path.relative(root, file)} not found`);
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch (e) {
    fail(`${path.relative(root, file)} isn't valid JSON: ${(e as Error).message}`);
  }
}

function saveTrace(t: Trace, kind: "runs" | "tests" | "checks" = "runs") {
  mkdirSync(tracesDir(kind), { recursive: true });
  writeFileSync(path.join(tracesDir(kind), `${t.id}.json`), JSON.stringify(t, null, 2) + "\n");
}

/** Traces from `run` (what review and group use), or from every source (for `show`). */
function allTraces(kinds: ("runs" | "tests" | "checks")[] = ["runs"]): Trace[] {
  return kinds
    .flatMap((k) => (existsSync(tracesDir(k)) ? readdirSync(tracesDir(k)).filter((f) => f.endsWith(".json")).map((f) => path.join(tracesDir(k), f)) : []))
    .flatMap((f) => {
      try {
        return [JSON.parse(readFileSync(f, "utf8")) as Trace];
      } catch {
        console.log(yellow(`! skipping unreadable trace ${path.relative(root, f)}`));
        return [];
      }
    })
    .sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? ""));
}

function findTrace(id: string, kinds: ("runs" | "tests" | "checks")[] = ["runs", "tests", "checks"]): Trace | undefined {
  const all = allTraces(kinds);
  const exact = all.find((x) => x.id === id);
  if (exact) return exact;
  const matches = all.filter((x) => x.id.startsWith(id));
  if (matches.length > 1) fail(`"${id}" matches ${matches.length} traces (${matches.slice(0, 3).map((x) => x.id).join(", ")}…). Use more of the id.`);
  return matches[0];
}

let configPath: string | undefined;

async function setup(): Promise<{ config: Config; agent: AgentDefinition }> {
  const config = loadConfig(root, configPath);
  await prepare(root, config);
  const agent = await loadAgent(root, config);
  return { config, agent };
}

function line(t: Trace): string {
  const agentTurns = t.turns.filter((x) => x.role === "agent").length;
  const flags = t.checks.map((x) => x.check);
  const mark = t.ended === "agent-error" || flags.length ? yellow("!") : green("·");
  const err = t.error ? ` ${red(t.error.split("\n")[0]!.slice(0, 140))}` : "";
  return `${mark} ${t.id}  ${agentTurns} turns, ${t.events.length} events, ${t.ended}, ${(t.durationMs / 1000).toFixed(0)}s${flags.length ? `  ${yellow(flags.join(", "))}` : ""}${err}`;
}

// ---------------------------------------------------------------------------

const AGENT_TEMPLATE = `import { defineAgent } from "create-evals";
// Import the agent the way production calls it, e.g.:
// import { createAgent } from "../src/agent.js";

export default defineAgent({
  name: "my-agent",
  description: "What the agent does and who talks to it.",
  // The system prompt and policy files the agent follows (repo-relative), so the reviewer can judge it.
  instructions: ["src/prompt.ts"],

  async start(ctx) {
    // Fresh state for this conversation. Fakes read it through current().state.
    // ctx.state.db = seedDatabase(ctx.profile.setup);
    const history: unknown[] = [];
    return {
      async send(message) {
        // Call the agent exactly as production does, and keep history exactly as production keeps it
        // (if the web page only sends text back, keep only text: that difference is where bugs hide).
        // Record the agent's tool calls and every change your fakes make, so the reviewer can check
        // what the agent said against what it did: ctx.record({ kind: "tool", name, input, output });
        throw new Error("evals/agent.ts: implement send()");
      },
      // What the agent changed, for the reviewer and tests:
      // state: () => ctx.state.db.snapshot(),
    };
  },
});
`;

const FUNCTION_TEMPLATE = `import { defineAgent } from "create-evals";
// Import the function the way production calls it, e.g.:
// import { triageTicket } from "../src/triage.js";

export default defineAgent({
  name: "my-function",
  kind: "function",
  description: "What the function decides or produces, and what happens with its output.",
  instructions: ["src/prompt.ts"],
  // A realistic input, sent by "create-evals check". Profiles use { "id": "...", "input": { ... } }.
  example: { text: "…" },

  async start(ctx) {
    return {
      async send(message) {
        const input = JSON.parse(message);
        // const output = await triageTicket(input);
        // ctx.record({ kind: "tool", name: "model call", input: ..., output: ... });   // anything in between
        // return JSON.stringify(output, null, 2);
        throw new Error("evals/agent.ts: implement send()");
      },
    };
  },
});
`;

/** `npx create-evals`: put the skill where coding agents look for it, then point the person at it. */
function cmdSetup() {
  const pkg = new URL("..", import.meta.url);
  const skillDir = new URL("skill/create-evals/", pkg);
  const done: string[] = [];
  // Claude Code: .claude/skills/create-evals/SKILL.md
  const dest = path.join(root, ".claude", "skills", "create-evals");
  mkdirSync(dest, { recursive: true });
  writeFileSync(path.join(dest, "SKILL.md"), readFileSync(new URL("SKILL.md", skillDir)));
  done.push(".claude/skills/create-evals (Claude Code)");
  // Codex, Cursor and others read AGENTS.md.
  const agentsMd = path.join(root, "AGENTS.md");
  const existing = existsSync(agentsMd) ? readFileSync(agentsMd, "utf8") : "";
  if (!existing.includes("## create-evals")) {
    writeFileSync(agentsMd, `${existing.replace(/\n*$/, existing ? "\n\n" : "")}${readFileSync(new URL("skill/AGENTS.md", pkg), "utf8")}`);
    done.push("AGENTS.md (Codex, Cursor and others)");
  }
  for (const d of done) console.log(green(`✔ ${d}`));
  console.log(`
Now open your coding agent in this folder and say:

  ${bold("/create-evals")}   ${dim("(or: \"find what my agent gets wrong and write evals for it\")")}

It runs your agent against simulated users, shows you what went wrong, asks which are bugs,
and writes tests. Needs ANTHROPIC_API_KEY.`);
}

/** run → review → group, for people: one command from "nothing" to "here's what's broken". */
async function cmdFind(f: Flags) {
  if (!existsSync(path.resolve(root, (f.profiles as string) || path.join(DIR, "profiles.json")))) {
    fail(`No ${DIR}/profiles.json yet. Ask your coding agent to run /create-evals, which writes it for your agent.`);
  }
  await cmdRun(f);
  await cmdReview(f);
  await cmdGroup(f);
}

function cmdInit(f: Flags) {
  mkdirSync(path.join(root, "evals"), { recursive: true });
  const files: [string, string][] = [
    ["evals/agent.ts", f.function ? FUNCTION_TEMPLATE : AGENT_TEMPLATE],
    [CONFIG_PATH, JSON.stringify({ agent: "evals/agent.ts", allowHosts: [], replace: {}, env: {} }, null, 2) + "\n"],
  ];
  for (const [rel, content] of files) {
    const file = path.join(root, rel);
    if (existsSync(file)) console.log(dim(`· kept ${rel}`));
    else {
      writeFileSync(file, content);
      console.log(green(`✔ wrote ${rel}`));
    }
  }
  const gi = path.join(root, ".gitignore");
  const ignore = existsSync(gi) ? readFileSync(gi, "utf8") : "";
  if (!ignore.split("\n").includes(`${DIR}/`)) {
    writeFileSync(gi, `${ignore.replace(/\n?$/, "\n")}${DIR}/\n`);
    console.log(green(`✔ added ${DIR}/ to .gitignore`));
  }
}

async function cmdCheck(f: Flags) {
  const { agent } = await setup();
  const fn = agent.kind === "function" || typeof f.message === "string";
  if (fn && agent.example === undefined && typeof f.message !== "string") fail('A function agent needs an `example` input in evals/agent.ts (or pass --message) for check to send.');
  const profile: Profile = fn
    ? { id: "check", input: typeof f.message === "string" ? f.message : agent.example }
    : {
        id: "check",
        persona: `You're trying this agent for the first time. ${agent.example !== undefined ? `Open with exactly: "${agent.example}".` : "Ask one realistic, simple question it's meant to handle."} Then ask one follow-up that depends on its previous answer. Then stop.`,
        maxTurns: 2,
      };
  if (!fn) requireKey(DEFAULT_MODELS().user);
  console.log(dim(`Running one short conversation with ${agent.name}…`));
  const t = await converse(agent, profile, { userModel: DEFAULT_MODELS().user });
  saveTrace(t, "checks");
  console.log(render(t));
  console.log();
  const problems: string[] = [];
  const agentTurns = t.turns.filter((x) => x.role === "agent");
  if (t.ended === "agent-error") problems.push(`The agent threw: ${t.error}`);
  if (!fn && agentTurns.length < 2 && t.ended !== "agent-error") problems.push("The conversation ended before a second turn.");
  if (t.ended !== "agent-error" && agentTurns.some((x) => !x.text.trim())) problems.push("An agent reply was empty: does send() return the reply text?");
  if (blocked.length) problems.push(`Blocked network calls to: ${[...new Set(blocked)].join(", ")}. Fake them (evals/create-evals.json "replace") or allow them.`);
  const notes: string[] = [];
  if (!t.events.length) notes.push("No events were recorded. If the agent used tools, record them with ctx.record() so reviews can check said-vs-did.");
  if (t.state === undefined) notes.push("The session reports no end state. If the agent changes anything, return it from state().");
  for (const n of notes) console.log(yellow(`! ${n}`));
  if (problems.length) {
    for (const p of problems) console.log(red(`✖ ${p}`));
    process.exit(1);
  }
  console.log(green(`✔ ${agent.name} runs: ${agentTurns.length} turns, ${t.events.length} events recorded. Trace: ${t.id}`));
}

async function cmdRun(f: Flags) {
  const { config, agent } = await setup();
  const file = path.resolve(root, (f.profiles as string) || path.join(DIR, "profiles.json"));
  let profiles = readJson<{ profiles: Profile[] }>(file).profiles;
  if (f.only) {
    const only = String(f.only).split(",");
    profiles = profiles.filter((p) => only.includes(p.id));
  }
  const repeat = count(f, "repeat", 1);
  const queue = profiles.flatMap((p) => Array.from({ length: repeat }, () => p));
  if (!queue.length) fail("No profiles to run.");
  const userModel = (f["user-model"] as string) || DEFAULT_MODELS().user;
  if (queue.some((p) => p.input === undefined)) requireKey(userModel);
  console.log(dim(`Running ${queue.length} conversation(s) with ${agent.name}…`));
  const traces = await converseAll(agent, queue, {
    concurrency: count(f, "concurrency", config.concurrency ?? 4),
    userModel,
    onDone: (t) => {
      saveTrace(t);
      console.log(line(t));
    },
  });
  const flagged = traces.filter((t) => t.checks.length || t.ended === "agent-error").length;
  console.log(`\n${traces.length} traces saved to ${DIR}/traces/${flagged ? `, ${yellow(`${flagged} with basic-check findings`)}` : ""}. Next: create-evals review`);
  if (traces.every((t) => t.ended === "user-error" || t.ended === "agent-error")) fail("Every conversation failed before it got going. Check the errors above (create-evals show <id>).");
}

async function cmdReview(f: Flags) {
  const { config, agent } = await setup();
  const modelId = (f.model as string) || DEFAULT_MODELS().review;
  requireKey(modelId);
  // A conversation the simulated user never got going has nothing to review.
  const todo = allTraces().filter((t) => (f.all || !t.review) && !(t.ended === "user-error" && t.turns.length < 2));
  if (!todo.length) return console.log("Nothing to review. Run `create-evals run` first, or pass --all.");
  const ctx = { description: agent.description, instructions: readInstructions(root, agent) };
  console.log(dim(`Reviewing ${todo.length} trace(s) with ${modelId}…`));
  let withProblems = 0;
  const queue = [...todo];
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      for (let t = queue.shift(); t; t = queue.shift()) {
        try {
          t.review = await review(t, ctx, modelId);
        } catch (e) {
          console.log(red(`✖ ${t.id}: ${(e as Error).message}`));
          continue;
        }
        saveTrace(t);
        const ps = t.review.problems;
        if (ps.length) withProblems++;
        const sim = t.review.simulatorIssues.length ? dim(` (simulator: ${t.review.simulatorIssues.join("; ").slice(0, 120)})`) : "";
        console.log(ps.length ? `${yellow("!")} ${t.id}: ${ps.map((p) => `[${p.severity}] ${p.what}`).join(" | ")}${sim}` : `${green("·")} ${t.id}: ok${sim}`);
      }
    }),
  );
  const reviewed = todo.filter((t) => t.review).length;
  console.log(`\n${withProblems}/${reviewed} reviewed conversations had problems${reviewed < todo.length ? red(`; ${todo.length - reviewed} reviews failed`) : ""}. Next: create-evals group`);
  if (!reviewed) process.exit(1);
}

async function cmdGroup(f: Flags) {
  const { config, agent } = await setup();
  const modelId = (f.model as string) || DEFAULT_MODELS().group;
  requireKey(modelId);
  const traces = allTraces();
  const reviewed = traces.filter((t) => t.review);
  if (!reviewed.length) fail("No reviewed traces. Run `create-evals review` first.");
  const previous = existsSync(dir("failures.json")) ? readJson<{ modes: FailureMode[] }>(dir("failures.json")).modes : [];
  const modes = await group(reviewed, agent.description, modelId, previous);
  const seen = new Set(previous.flatMap((m) => m.traces));
  const known = new Set(previous.map((m) => m.id));
  for (const m of modes) if (previous.length && !known.has(m.id) && !m.traces.some((t) => seen.has(t))) m.title = `[new] ${m.title}`;
  if (previous.length) writeFileSync(dir("failures.prev.json"), readFileSync(dir("failures.json")));
  writeFileSync(dir("failures.json"), JSON.stringify({ reviewed: reviewed.length, modes }, null, 2) + "\n");
  if (!modes.length) return console.log(green(`No problems found in ${reviewed.length} conversations. Make the profiles harder and run again.`));
  console.log(bold(`${modes.length} failure mode(s) across ${reviewed.length} reviewed conversations:\n`));
  for (const m of modes) printMode(m, reviewed.length);
  console.log(dim(`Saved to ${DIR}/failures.json. Read the traces behind each mode (create-evals show <trace>). Report clear bugs; ask the developer only about judgment calls, in plain words.`));
}

function printMode(m: FailureMode, total: number) {
  const sev = m.severity === "high" ? red(m.severity) : m.severity === "medium" ? yellow(m.severity) : dim(m.severity);
  console.log(`${bold(m.title)}  ${dim(`${m.id} · ${m.traces.length}/${total} conversations ·`)} ${sev}`);
  console.log(`  rule: ${m.should}`);
  for (const n of m.notes.slice(0, 3)) console.log(dim(`  - ${n}`));
  console.log();
}

function cmdShow(f: Flags) {
  const id = f._[1];
  if (!id) fail("Usage: create-evals show <trace-id>");
  const t = findTrace(id);
  if (!t) fail(`No trace ${id}`);
  console.log(bold(`${t.id}`) + dim(`  persona: ${(t.profile.persona ?? JSON.stringify(t.profile.input) ?? "").slice(0, 200)}`));
  console.log(render(t, { clip: f.full ? 100_000 : 240 }));
  if (t.checks.length) console.log(`\n${yellow("Basic checks:")} ${t.checks.map((x) => `${x.check} (${x.detail})`).join("; ")}`);
  if (t.review) {
    console.log(`\n${bold("Review")} ${dim(t.review.model)}: ${t.review.summary}`);
    for (const p of t.review.problems) console.log(`  [${p.severity}] turn ${p.turn}: ${p.what}\n    "${p.evidence}"`);
    if (t.review.simulatorIssues.length) console.log(dim(`  simulator: ${t.review.simulatorIssues.join("; ")}`));
  }
}

/** Every run trace on one screen, so patterns across runs (rates, outliers) are visible. */
function cmdList() {
  const traces = allTraces();
  if (!traces.length) return console.log("No traces yet. Run `create-evals run`.");
  const one = (s: string, n: number) => {
    const flat = s.replace(/\s+/g, " ").trim();
    return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
  };
  for (const t of traces) {
    const first = t.turns.find((x) => x.role === "user")?.text ?? "";
    // For a function, the output is the answer; for a chat, the review summary says more than a closing "you're welcome".
    const last = t.profile.input !== undefined ? ([...t.turns].reverse().find((x) => x.role === "agent")?.text ?? "") : (t.review?.summary ?? [...t.turns].reverse().find((x) => x.role === "agent")?.text ?? "");
    const probs = t.review ? (t.review.problems.length ? yellow(`${t.review.problems.length} problem(s)`) : green("ok")) : dim("not reviewed");
    console.log(`${bold(t.id)}  ${dim(`${t.turns.filter((x) => x.role === "agent").length} turns, ${t.ended}`)}  ${probs}${t.checks.length ? yellow(`  ${t.checks.map((c) => c.check).join(",")}`) : ""}`);
    console.log(`  in:  ${one(first, 150)}`);
    console.log(`  ${t.profile.input !== undefined || !t.review ? "out" : "summary"}: ${one(last || "[empty]", 150)}`);
  }
  console.log(dim(`\n${traces.length} runs. Full detail: create-evals show <id>`));
}

function cmdDrop(f: Flags) {
  const ids = f._.slice(1);
  if (!ids.length) fail("Usage: create-evals drop <trace-id…>");
  for (const id of ids) {
    const t = findTrace(id);
    if (!t) {
      console.log(yellow(`! no trace ${id}`));
      continue;
    }
    for (const k of ["runs", "tests", "checks"] as const) rmSync(path.join(tracesDir(k), `${t.id}.json`), { force: true });
    console.log(dim(`· dropped ${t.id}`));
  }
}

function cmdReset() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = dir("archive", stamp);
  let moved = 0;
  for (const name of ["traces", "test-traces", "check-traces", "failures.json", "failures.prev.json"]) {
    if (!existsSync(dir(name))) continue;
    mkdirSync(dest, { recursive: true });
    renameSync(dir(name), path.join(dest, name));
    moved++;
  }
  console.log(moved ? green(`✔ archived the current round to ${path.relative(root, dest)}`) : "Nothing to archive.");
}

function cmdStatus() {
  const traces = allTraces();
  const reviewed = traces.filter((t) => t.review);
  const failures = existsSync(dir("failures.json")) ? readJson<{ modes: FailureMode[] }>(dir("failures.json")).modes : [];
  console.log(`${traces.length} traces, ${reviewed.length} reviewed, ${reviewed.filter((t) => t.review!.problems.length).length} with problems, ${failures.length} failure modes`);
  for (const m of failures) console.log(`  ${m.id}: ${m.title} (${m.traces.length})`);
}

async function cmdTest(f: Flags) {
  const { config } = await setup();
  const files = f._.length > 1 ? f._.slice(1).map((x) => path.resolve(root, x)) : existsSync(path.join(root, "evals")) ? readdirSync(path.join(root, "evals")).filter((x) => /\.eval\.[cm]?[jt]s$/.test(x)).map((x) => path.join(root, "evals", x)) : [];
  if (!files.length) fail("No evals/*.eval.ts files.");
  for (const file of files) {
    setCurrentFile(path.relative(root, file));
    await import(pathToFileURL(file).href);
  }
  let tests = registered();
  if (f.tier) tests = tests.filter((t) => (t.opts.tier ?? "usually") === f.tier);
  if (f.only) tests = tests.filter((t) => t.name.includes(String(f.only)));
  if (f.tier && !["always", "usually"].includes(String(f.tier))) fail(`--tier must be "always" or "usually", got "${f.tier}"`);
  if (!tests.length) fail(`No tests selected${f.only || f.tier ? " (check --only / --tier)" : ""}.`);
  const runsOverride = f.runs !== undefined ? count(f, "runs", 1) : process.env.CREATE_EVALS_RUNS ? Number(process.env.CREATE_EVALS_RUNS) : undefined;
  const userModel = (f["user-model"] as string) || DEFAULT_MODELS().user;
  if (tests.some((t) => t.opts.profile.input === undefined)) requireKey(userModel);
  console.log(dim(`Running ${tests.length} test(s)…`));

  const jobs = tests.flatMap((t) => Array.from({ length: runsOverride ?? t.opts.runs ?? 1 }, (_, i) => ({ t, i })));
  const results = new Map<Registered, { pass: number; skipped: number; fails: { reason: string; trace: string }[] }>();
  const queue = [...jobs];
  await Promise.all(
    Array.from({ length: count(f, "concurrency", config.concurrency ?? 4) }, async () => {
      for (let job = queue.shift(); job; job = queue.shift()) {
        const { t } = job;
        const r = results.get(t) ?? { pass: 0, skipped: 0, fails: [] };
        results.set(t, r);
        const profile = { id: t.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40), ...t.opts.profile } as Profile;
        const trace = await converse(t.agent, profile, { userModel });
        trace.id = `test-${trace.id}`;
        // The simulated user failing (e.g. a model declining the persona) says nothing about the agent.
        if (trace.ended === "user-error" && trace.turns.length < 2) {
          r.skipped++;
          trace.test = { name: t.name, passed: false, reason: `skipped: ${trace.error}` };
          saveTrace(trace, "tests");
          continue;
        }
        try {
          const bad = trace.checks.filter((x) => !(t.opts.allow ?? []).includes(x.check));
          if (bad.length) throw new Error(`basic check: ${bad.map((x) => `${x.check} (${x.detail})`).join("; ")}`);
          const transcript = render(trace);
          const said = trace.turns.filter((x) => x.role === "agent").map((x) => x.text).join("\n");
          await t.opts.check?.({ trace, state: trace.state, transcript, said });
          r.pass++;
          trace.test = { name: t.name, passed: true };
        } catch (e) {
          const reason = (e as Error).message;
          if ((e as Error).name === "JudgeUnavailable") {
            r.skipped++;
            trace.test = { name: t.name, passed: false, reason: `skipped: ${reason}` };
            saveTrace(trace, "tests");
            continue;
          }
          r.fails.push({ reason: reason.slice(0, 1200), trace: trace.id });
          trace.test = { name: t.name, passed: false, reason };
        }
        saveTrace(trace, "tests");
      }
    }),
  );

  // A test passes when enough counted runs pass for its tier. No counted runs (all skipped) is a failure.
  const verdict = (t: Registered) => {
    const r = results.get(t) ?? { pass: 0, skipped: 0, fails: [] };
    const runs = r.pass + r.fails.length;
    const tier = t.opts.tier ?? "usually";
    const need = Math.min(t.opts.atLeast ?? (tier === "always" ? runs : Math.ceil((runs * 2) / 3)), runs);
    return { r, runs, tier, ok: runs > 0 && r.pass >= need };
  };
  let blocking = 0;
  for (const t of tests) {
    const { r, runs, tier, ok } = verdict(t);
    if (!ok && tier === "always") blocking++;
    const mark = ok ? green("✔") : tier === "always" ? red("✖") : yellow("~");
    const skipped = r.skipped ? `, ${r.skipped} skipped (simulated user or judge failed)` : "";
    console.log(`${mark} ${t.name} ${dim(`(${r.pass}/${runs}${skipped}, ${tier}, ${t.file})`)}`);
    for (const fl of r.fails.slice(0, 2)) console.log(dim(`${fl.reason.replace(/^/gm, "    ")}\n    → create-evals show ${fl.trace}`));
  }
  const failing = tests.filter((t) => !verdict(t).ok).length;
  console.log(`\n${tests.length - failing}/${tests.length} passing${failing ? `, ${failing} failing (${blocking} blocking: tier "always")` : ""}`);
  // Only "always" tests block (CI). "usually" failures are reported but don't fail the run.
  if (blocking) process.exit(1);
}

async function main() {
  const f = parse(process.argv.slice(2));
  if (f.version) return console.log(VERSION);
  if (typeof f.config === "string") configPath = f.config;
  const cmd = f._[0];
  if (f.help || cmd === "help") return console.log(HELP);
  if (!cmd || cmd === "setup") return cmdSetup();
  if (cmd === "find") return cmdFind(f);
  if (cmd === "init") return cmdInit(f);
  if (cmd === "list") return cmdList();
  if (cmd === "check") return cmdCheck(f);
  if (cmd === "run") return cmdRun(f);
  if (cmd === "review") return cmdReview(f);
  if (cmd === "group") return cmdGroup(f);
  if (cmd === "show") return cmdShow(f);
  if (cmd === "status") return cmdStatus();
  if (cmd === "drop") return cmdDrop(f);
  if (cmd === "reset") return cmdReset();
  if (cmd === "test") return cmdTest(f);
  fail(`Unknown command "${cmd}". Run create-evals --help.`);
}

main().catch((e) => fail(e?.stack ?? String(e)));
