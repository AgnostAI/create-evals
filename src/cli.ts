#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { applyPatch, copyRepo, removeText } from "./ablate.js";
import type { AgentDefinition } from "./agent.js";
import { installHook, writeWorkflow, type Step } from "./ci.js";
import { readRecords, toProfiles } from "./import.js";
import { DEFAULT_MODELS, keyFor, usageLine } from "./llm.js";
import { CONFIG_PATH, DIR, loadAgents, loadConfig, pickAgent, prepare, readInstructions, type Config } from "./project.js";
import { consistency, group, review } from "./review.js";
import { converse, converseAll, parseJson } from "./run.js";
import { blocked } from "./sandbox.js";
import { registered, scenarioProfile, setCurrentFile, type Registered } from "./scenario.js";
import { render } from "./trace.js";
import type { FailureMode, Profile, Trace } from "./types.js";
import { describe, modeRates, variance } from "./variance.js";

const VERSION = "0.1.7";
const tty = process.stdout.isTTY;
const c = (code: number) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const [bold, dim, red, green, yellow] = [c(1), c(2), c(31), c(32), c(33)];

const HELP = `${bold("create-evals")} ${VERSION}: find your agent's real failures and turn each one into a test.

${bold("Start here")}
  npx create-evals                  set up the skill, then open your coding agent and run /create-evals

${bold("Day to day")}
  create-evals find                 run your agent on realistic cases, review every run, list what went wrong
  create-evals test                 run the tests in evals/ (--tier always in CI)
  create-evals hook                 run them before every commit (optional)
  create-evals ci                   run them in GitHub Actions (optional)

${bold("Building blocks")} (the skill uses these)
  init [--function] [--python]      scaffold evals/agent.ts (+ evals/run_agent.py in a Python repo) and ${CONFIG_PATH}
  check [--message m] [--agent a]   run the example input (or one short chat), to prove the setup works
  import <file> [--input-field f]   real records (JSONL, JSON, CSV) → profiles: replay production inputs
  run [--profiles f] [--only a,b] [--repeat n] [--agent a]
  review [--all] [--concurrency n]  note what went wrong in each new trace (6 at a time by default)
  group [--no-consistency]          merge the notes into failure modes, and compare agents and inputs for
                                    rules applied differently (${DIR}/failures.json)
  list [--json] | show <id> [--full] | status
  docs                              the full reference: config, binding API, scenario(), spawnSession(), Python helper
  drop <id…> | reset                discard bad traces, or archive this round and start fresh
  test [files] [--runs n] [--tier always|usually] [--only text] [--precommit]
  ablate --test t (--remove text | --remove-file f) --in file | --patch f.diff
                                    does a test have teeth? runs it on a temp copy with the change applied

Options: --config <file>, --model <id> (review/group), --user-model <id>, --concurrency <n>
Docs: https://github.com/AgnostAI/create-evals`;

interface Flags {
  _: string[];
  [k: string]: string | boolean | string[];
}

const BOOLEAN_FLAGS = ["all", "help", "version", "full", "function", "json", "precommit", "no-consistency", "no-baseline", "keep", "yes", "python"];

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

async function setup(): Promise<{ config: Config; agents: AgentDefinition[] }> {
  const config = loadConfig(root, configPath);
  await prepare(root, config);
  const agents = await loadAgents(root, config);
  return { config, agents };
}

/** Run a step that may throw a usage error (no such agent…) and report it plainly. */
function attempt<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    fail((e as Error).message);
  }
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
  // The output fields that are decisions, so flips between runs are reported: ["status", "is_*"].
  // decisions: [],
  // Several functions (a pipeline's stages)? One defineAgent each, then \`export default defineAgents([a, b])\`.

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

/** A Python agent: the binding starts evals/run_agent.py once per conversation. */
const pythonAgentTemplate = (fn: boolean, python: string) => `import { defineAgent, spawnSession } from "create-evals";

// The agent runs in Python, one process per conversation: evals/run_agent.py.
// Several agents (a pipeline's stages)? Define one per stage, each with its own instructions, and
// \`export default defineAgents([triage, research])\`. Profiles pick one with "agent"; run_agent.py sees it as profile["agent"].
export default defineAgent({
  name: "my-agent",${fn ? `\n  kind: "function",` : ""}
  description: "${fn ? "What the function decides or produces, and what happens with its output." : "What the agent does and who talks to it."}",
  // The prompt and policy files the agent follows (repo-relative), so the reviewer can judge it.
  instructions: ["app/prompts.py"],${fn ? `\n  // A realistic input, sent by "create-evals check". Profiles use { "id": "...", "input": { ... } }.\n  example: { text: "…" },\n  // The output fields that are decisions, so flips between runs are reported: ["status", "is_*"].\n  // decisions: [],` : ""}
  start: (ctx) => spawnSession(ctx, ["${python}", "evals/run_agent.py"], { allowHosts: [] }),
});
`;

const pythonRunnerTemplate = (fn: boolean) => `"""create-evals starts this once per conversation (see evals/agent.ts). Reference: npx create-evals docs"""
from create_evals import guard, record, serve

guard()  # first: blocks every host except model APIs and allowHosts

import json

# Then import the real agent, the way production calls it. The repo root (and src/) is on the path.
# from myapp.agent import Agent
# Fake what it calls here (monkeypatch the client or module), and record each call:
#   record("tool", "search", {"q": query}, results)


def handle(message, profile):
${
  fn
    ? `    data = json.loads(message)
    # output = run_my_function(data)       # with several agents: branch on profile.get("agent")
    # return json.dumps(output)            # a JSON reply is the end state; checks read its fields`
    : `    # One process is one conversation: keep history the way production does.
    # return agent.reply(message)`
}
    raise NotImplementedError("evals/run_agent.py: call your agent here")


serve(handle)
`;

/** A repo whose agent is Python: Python project files and no package.json. */
function isPythonRepo(): boolean {
  const has = (f: string) => existsSync(path.join(root, f));
  return !has("package.json") && ["pyproject.toml", "requirements.txt", "setup.py", "uv.lock"].some(has);
}

/** `npx create-evals`: put the skill where coding agents look for it, then point the person at it. */
async function cmdSetup(f: Flags) {
  const pkg = new URL("..", import.meta.url);
  const skillDir = new URL("skill/create-evals/", pkg);
  const skillFile = path.join(root, ".claude", "skills", "create-evals", "SKILL.md");
  const agentsMd = path.join(root, "AGENTS.md");
  const existing = existsSync(agentsMd) ? readFileSync(agentsMd, "utf8") : "";
  const plan = [
    `${existsSync(skillFile) ? "update" : "add"} .claude/skills/create-evals/SKILL.md (Claude Code)`,
    ...(existing.includes("## create-evals") ? [] : [existing ? "append a create-evals section to your AGENTS.md (Codex, Cursor and others)" : "add AGENTS.md (Codex, Cursor and others)"]),
  ];
  // Ask before touching someone's repo, when a person is there to answer.
  if (process.stdin.isTTY && process.stdout.isTTY && !f.yes) {
    console.log(`create-evals will:\n${plan.map((p) => `  - ${p}`).join("\n")}`);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question("Go ahead? [Y/n] ")).trim().toLowerCase();
    rl.close();
    if (answer && !answer.startsWith("y")) return console.log("Nothing written.");
  }
  mkdirSync(path.dirname(skillFile), { recursive: true });
  writeFileSync(skillFile, readFileSync(new URL("SKILL.md", skillDir)));
  if (!existing.includes("## create-evals")) {
    writeFileSync(agentsMd, `${existing.replace(/\n*$/, existing ? "\n\n" : "")}${readFileSync(new URL("skill/AGENTS.md", pkg), "utf8")}`);
  }
  for (const d of plan) console.log(green(`✔ ${d.replace(/^(\w)/, (c) => c.toUpperCase())}`));
  console.log(dim(`These are new or changed files in your repo: commit them so your team's coding agents find the skill, or add them to .gitignore.`));
  console.log(`
Now open your coding agent in this folder and say:

  ${bold("/create-evals")}   ${dim("(or: \"find what my agent gets wrong and write evals for it\")")}

It runs your agent on realistic cases (chats, functions or pipelines), shows you what went wrong, asks you about anything
that's your call, and writes tests. Takes about 20–30 minutes for one agent, longer for a pipeline.
Needs ANTHROPIC_API_KEY.`);
}

function report(step: Step) {
  if (step.kind === "wrote") console.log(green(`✔ ${step.text}`));
  else if (step.kind === "kept") console.log(dim(`· kept ${step.text}`));
  else console.log(yellow(`! ${step.text}`));
}

/** `create-evals hook`: the evals that pass today run before every commit. Only when the developer asks for it. */
function cmdHook() {
  report(installHook(root));
  console.log("\nBefore each commit, the evals marked always run. Known bugs never block. Skip once: git commit --no-verify");
}

/** `create-evals ci`: the same evals on every push, in GitHub Actions. Only when the developer asks for it. */
function cmdCi() {
  report(writeWorkflow(root));
  console.log("\nOn every push, the evals marked always run. Last step: add ANTHROPIC_API_KEY to your GitHub repo's secrets.");
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
  const python = Boolean(f.python) || isPythonRepo();
  const exe = existsSync(path.join(root, ".venv/bin/python")) ? ".venv/bin/python" : "python3";
  if (python) console.log(dim(`Python repo: the binding starts evals/run_agent.py with ${exe}.`));
  const files: [string, string][] = [
    ["evals/agent.ts", python ? pythonAgentTemplate(Boolean(f.function), exe) : f.function ? FUNCTION_TEMPLATE : AGENT_TEMPLATE],
    ...(python ? ([["evals/run_agent.py", pythonRunnerTemplate(Boolean(f.function))]] as [string, string][]) : []),
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
  const { agents } = await setup();
  // With several agents, check the one named, or each of them in turn.
  const picked = f.agent ? [attempt(() => pickAgent(agents, String(f.agent)))] : agents;
  let failed = false;
  for (const agent of picked) failed = !(await checkOne(agent, f)) || failed;
  if (failed) process.exit(1);
}

async function checkOne(agent: AgentDefinition, f: Flags): Promise<boolean> {
  const fn = agent.kind === "function" || typeof f.message === "string";
  if (fn && agent.example === undefined && typeof f.message !== "string") fail(`${agent.name}: a function agent needs an \`example\` input in evals/agent.ts (or pass --message) for check to send.`);
  const profile: Profile = fn
    ? { id: "check", input: typeof f.message === "string" ? f.message : agent.example }
    : {
        id: "check",
        persona: `You're trying this agent for the first time. ${agent.example !== undefined ? `Open with exactly: "${agent.example}".` : "Ask one realistic, simple question it's meant to handle."} Then ask one follow-up that depends on its previous answer. Then stop.`,
        maxTurns: 2,
      };
  if (!fn) requireKey(DEFAULT_MODELS().user);
  console.log(dim(`Running ${fn ? "the example input" : "one short conversation"} with ${agent.name}…`));
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
  // The reviewer believes the record. Tool calls logged without their input usually mean the recorder misreads the
  // response (e.g. server-side tools logged under the wrong name), and reviewers then report problems that didn't happen.
  const empty = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length) || (typeof v === "object" && !Array.isArray(v) && Object.values(v as object).every((x) => x === null || x === undefined || x === ""));
  const tools = t.events.filter((e) => e.kind === "tool");
  const names = (es: typeof tools) => [...new Set(es.map((e) => e.name))].slice(0, 3).join(", ");
  const noInput = tools.filter((e) => empty(e.input));
  const noOutput = tools.filter((e) => empty(e.output));
  if (noInput.length) notes.push(`${noInput.length} of ${tools.length} recorded tool calls have no input (${names(noInput)}). Check the recorder against the raw response: the reviewer takes events at face value.`);
  if (noOutput.length) notes.push(`${noOutput.length} of ${tools.length} recorded tool calls have no result (${names(noOutput)}). If the tool did return something (a built-in search, a fake), the recorder is dropping it, and the reviewer will think the agent acted on nothing.`);
  // A function's JSON reply is its end state; only a reply that isn't JSON (or a chat with no state()) is worth a note.
  if (t.state === undefined && !fn) notes.push("The session reports no end state. If the agent changes anything, return it from state().");
  if (t.state === undefined && fn && t.ended !== "agent-error") notes.push("The reply isn't JSON, so checks can only read it as text. Return JSON.stringify(output) from send() to check fields.");
  for (const n of notes) console.log(yellow(`! ${n}`));
  if (problems.length) {
    for (const p of problems) console.log(red(`✖ ${p}`));
    return false;
  }
  console.log(green(`✔ ${agent.name} runs: ${agentTurns.length} turns, ${t.events.length} events recorded. Trace: ${t.id}`));
  return true;
}

async function cmdRun(f: Flags) {
  const { config, agents } = await setup();
  const file = path.resolve(root, (f.profiles as string) || path.join(DIR, "profiles.json"));
  let profiles = readJson<{ profiles: Profile[] }>(file).profiles;
  if (f.only) {
    const only = String(f.only).split(",");
    profiles = profiles.filter((p) => only.includes(p.id));
  }
  // --agent: run only that agent's profiles; profiles that name no agent are for it too.
  const agentName = typeof f.agent === "string" ? f.agent : undefined;
  if (agentName) profiles = profiles.filter((p) => (p.agent ?? agentName) === agentName);
  // Fail before running anything if a profile names no agent (or one that doesn't exist).
  const agentFor = new Map(profiles.map((p) => [p, attempt(() => pickAgent(agents, p.agent ?? agentName))]));
  const repeat = count(f, "repeat", 1);
  const queue = profiles.flatMap((p) => Array.from({ length: repeat }, () => p));
  if (!queue.length) fail("No profiles to run.");
  const userModel = (f["user-model"] as string) || DEFAULT_MODELS().user;
  if (queue.some((p) => p.input === undefined)) requireKey(userModel);
  console.log(dim(`Running ${queue.length} case(s) with ${[...new Set(queue.map((p) => agentFor.get(p)!.name))].join(", ")}…`));
  const traces = await converseAll((p) => agentFor.get(p)!, queue, {
    concurrency: count(f, "concurrency", config.concurrency ?? 4),
    userModel,
    onDone: (t) => {
      saveTrace(t);
      console.log(line(t));
    },
  });
  const flagged = traces.filter((t) => t.checks.length || t.ended === "agent-error").length;
  console.log(`\n${traces.length} traces saved to ${DIR}/traces/${flagged ? `, ${yellow(`${flagged} with basic-check findings`)}` : ""}. Next: create-evals review`);
  if (traces.every((t) => t.ended === "user-error" || t.ended === "agent-error")) fail("Every run failed before it got going. Check the errors above (create-evals show <id>).");
}

async function cmdReview(f: Flags) {
  const { agents } = await setup();
  const modelId = (f.model as string) || DEFAULT_MODELS().review;
  requireKey(modelId);
  // A conversation the simulated user never got going has nothing to review.
  const todo = allTraces().filter((t) => (f.all || !t.review) && !(t.ended === "user-error" && t.turns.length < 2));
  if (!todo.length) return console.log("Nothing to review. Run `create-evals run` first, or pass --all.");
  // Each trace is judged against its own agent's instructions, not every prompt in the repo.
  const contexts = new Map(agents.map((a) => [a.name, { description: a.description, instructions: readInstructions(root, a) }]));
  const ctxFor = (t: Trace) => contexts.get(t.agent) ?? (agents.length === 1 ? contexts.get(agents[0]!.name)! : { description: "(unknown agent)", instructions: "" });
  console.log(dim(`Reviewing ${todo.length} trace(s) with ${modelId}…`));
  let withProblems = 0;
  const queue = [...todo];
  await Promise.all(
    Array.from({ length: count(f, "concurrency", 6) }, async () => {
      for (let t = queue.shift(); t; t = queue.shift()) {
        try {
          t.review = await review(t, ctxFor(t), modelId);
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
  console.log(`\n${withProblems}/${reviewed} reviewed runs had problems${reviewed < todo.length ? red(`; ${todo.length - reviewed} reviews failed`) : ""}. Next: create-evals group`);
  if (!reviewed) process.exit(1);
}

async function cmdGroup(f: Flags) {
  const { agents } = await setup();
  const modelId = (f.model as string) || DEFAULT_MODELS().group;
  requireKey(modelId);
  const traces = allTraces();
  const reviewed = traces.filter((t) => t.review);
  if (!reviewed.length) fail("No reviewed traces. Run `create-evals review` first.");
  const previous = existsSync(dir("failures.json")) ? readJson<{ modes: FailureMode[] }>(dir("failures.json")).modes : [];
  const description = agents.length === 1 ? agents[0]!.description : `A system of ${agents.length} agents:\n${agents.map((a) => `- ${a.name}: ${a.description}`).join("\n")}`;
  // Comparing runs side by side catches what one-trace reviews can't: the same rule applied two ways.
  // Worth it for pipelines (several agents) and for functions (many comparable inputs).
  const compare = !f["no-consistency"] && (agents.length > 1 || reviewed.some((t) => t.profile.input !== undefined)) && reviewed.length > 1;
  if (compare) console.log(dim(`Grouping notes and comparing ${reviewed.length} runs${agents.length > 1 ? ` across ${agents.length} agents` : ""} for rules applied differently…`));
  const grouped = await group(reviewed, description, modelId, previous.filter((m) => m.kind !== "inconsistency"));
  // After grouping, so the comparison can skip what single runs already showed (one problem, one mode).
  const inconsistent = compare
    ? await consistency(reviewed, agents.map((a) => ({ name: a.name, description: a.description, instructions: readInstructions(root, a) })), modelId, grouped).catch((e) => {
        console.log(yellow(`! consistency check failed: ${(e as Error).message}`));
        return [] as FailureMode[];
      })
    : [];
  const modes = [...grouped, ...inconsistent];
  const seen = new Set(previous.flatMap((m) => m.traces));
  const known = new Set(previous.map((m) => m.id));
  for (const m of modes) if (previous.length && !known.has(m.id) && !m.traces.some((t) => seen.has(t))) m.title = `[new] ${m.title}`;
  if (previous.length) writeFileSync(dir("failures.prev.json"), readFileSync(dir("failures.json")));
  writeFileSync(dir("failures.json"), JSON.stringify({ reviewed: reviewed.length, modes }, null, 2) + "\n");
  const flips = variance(traces, await decisionFields(agents));
  if (!modes.length && !flips.length) return console.log(green(`No problems found in ${reviewed.length} runs. Make the cases harder and run again.`));
  if (modes.length) console.log(bold(`${modes.length} failure mode(s) across ${reviewed.length} reviewed runs:\n`));
  for (const m of modes) printMode(m, reviewed.length, traces, flips);
  printVariance(flips);
  console.log(dim(`Saved to ${DIR}/failures.json. Read the traces behind each mode (create-evals show <trace>). Report clear bugs; ask the developer only about judgment calls, in plain words.`));
}

function printMode(m: FailureMode, total: number, traces: Trace[], flips: ReturnType<typeof variance>) {
  const sev = m.severity === "high" ? red(m.severity) : m.severity === "medium" ? yellow(m.severity) : dim(m.severity);
  const where = m.kind === "inconsistency" ? "inconsistency, found by comparing runs" : `${m.traces.length}/${total} runs`;
  console.log(`${bold(m.title)}  ${dim(`${m.id} · ${where} ·`)} ${sev}`);
  console.log(`  rule: ${m.should}`);
  const rates = m.kind === "inconsistency" ? [] : modeRates(m, traces, flips);
  if (rates.length) console.log(yellow(`  ${rates.slice(0, 4).join("; ")}${rates.length > 4 ? "; …" : ""}`));
  for (const n of m.notes.slice(0, m.kind === "inconsistency" ? 4 : 3)) console.log(dim(`  - ${n}`));
  console.log();
}

/** The same input getting different answers is a finding in itself (a coin flip, not a reproducible bug). */
function printVariance(flips: ReturnType<typeof variance>) {
  // Decisions that flipped (yes/no fields, or the binding's `decisions`) lead; labels and scores that moved follow.
  // Mixed reviews alone don't lead: reviewers vary too. They're in the JSON, and in each mode's rate.
  const strong = flips.filter((v) => v.strong);
  const weak = flips.filter((v) => !strong.includes(v));
  if (strong.length) {
    console.log(bold(`Same input, different decisions: ${strong.length} input(s)`));
    for (const v of strong.slice(0, 15)) console.log(`  ${v.profile} ${dim(`(${v.agent}, ${v.runs} runs)`)}: ${describe(v)}`);
    if (strong.length > 15) console.log(dim(`  …and ${strong.length - 15} more`));
  }
  const moved = weak.filter((v) => v.fields.length);
  const reviewOnly = weak.filter((v) => !v.fields.length);
  if (moved.length) {
    console.log(dim(`${strong.length ? "Also: " : ""}${moved.length} input(s) where only labels or numbers changed, e.g. ${moved.slice(0, 2).map((v) => `${v.profile}: ${describe(v, 1)}`).join("; ")}.`));
    console.log(dim(`  Name the fields that are decisions with \`decisions: [...]\` in the binding. All of it: create-evals list --json → "variance"`));
  }
  // Same output, different verdicts: the reviewer varies too. Worth a look, not a flip.
  if (reviewOnly.length) console.log(dim(`${reviewOnly.length} input(s) got the same decisions every run, but the reviewer flagged only some runs (e.g. ${reviewOnly.slice(0, 3).map((v) => v.profile).join(", ")}).`));
  if (flips.length) console.log();
}

/** Each agent's declared decision fields, for variance. Loads the binding if it can; without it, shapes decide. */
async function decisionFields(agents?: AgentDefinition[]): Promise<Record<string, string[] | undefined>> {
  if (!agents) {
    try {
      agents = (await setup()).agents;
    } catch {
      return {};
    }
  }
  return Object.fromEntries(agents.map((a) => [a.name, a.decisions]));
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
async function cmdList(f: Flags) {
  const traces = allTraces();
  const decisions = traces.length ? await decisionFields() : {};
  if (f.json) {
    // For coding agents: everything needed to scan results across runs, without writing a script.
    const rows = traces.map((t) => {
      const lastReply = t.turns.findLast((x) => x.role === "agent")?.text ?? "";
      const fn = t.profile.input !== undefined;
      return {
        id: t.id,
        agent: t.agent,
        profile: t.profile.id,
        // For a function: what went in, and what came out (parsed when it's JSON). For a chat: first and last message.
        input: fn ? t.profile.input : (t.turns.find((x) => x.role === "user")?.text ?? null),
        output: fn ? (t.state ?? parseJson(lastReply) ?? lastReply) : lastReply,
        ended: t.ended,
        turns: t.turns.filter((x) => x.role === "agent").length,
        checks: t.checks.map((c) => c.check),
        problems: t.review?.problems.map((p) => `[${p.severity}] ${p.what}`) ?? null,
        lastReply,
        state: t.state ?? null,
        error: t.error ?? null,
      };
    });
    return console.log(JSON.stringify({ runs: rows, variance: variance(traces, decisions) }, null, 2));
  }
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
    if (t.state !== undefined) console.log(dim(`  state: ${one(JSON.stringify(t.state), 150)}`));
  }
  console.log();
  printVariance(variance(traces, decisions));
  console.log(dim(`${traces.length} runs. Full detail: create-evals show <id>. Everything as JSON: create-evals list --json`));
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
  // --precommit: the always evals, one run each; never blocks a commit just because there's no key.
  if (f.precommit) {
    f.tier = "always";
    f.runs ??= "1";
  }
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
  // Nothing marked always yet means nothing can block: fine for a hook or CI.
  if (!tests.length && f.tier === "always" && !f.only) return console.log(dim("No evals marked always yet, so nothing to block on."));
  if (!tests.length) fail(`No tests selected${f.only || f.tier ? " (check --only / --tier)" : ""}.`);
  const runsOverride = f.runs !== undefined ? count(f, "runs", 1) : process.env.CREATE_EVALS_RUNS ? Number(process.env.CREATE_EVALS_RUNS) : undefined;
  const userModel = (f["user-model"] as string) || DEFAULT_MODELS().user;
  if (f.precommit && !process.env[keyFor(userModel)]) return console.log(dim(`create-evals: skipped (${keyFor(userModel)} isn't set)`));
  if (tests.some((t) => scenarioProfile(t).input === undefined)) requireKey(userModel);
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
        const trace = await converse(t.agent, scenarioProfile(t), { userModel });
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
  // The same list the developer answered: one line per eval, ✔ or ✖, and one short reason when it fails.
  let blocking = 0;
  const failed: Registered[] = [];
  const pending: Registered[] = [];
  const report: { name: string; file: string; tier: string; passed: boolean; pending?: string; pass: number; runs: number; skipped: number }[] = [];
  for (const t of tests) {
    const { r, runs, tier, ok } = verdict(t);
    const waiting = t.opts.pending;
    report.push({ name: t.name, file: t.file, tier, passed: ok, ...(waiting ? { pending: waiting } : {}), pass: r.pass, runs, skipped: r.skipped });
    // A pending test is expected to fail until something else changes: reported, never counted as a failure.
    if (waiting && !ok) pending.push(t);
    else if (!ok) failed.push(t);
    if (!ok && !waiting && tier === "always") blocking++;
    const mark = ok ? green("✔") : waiting ? dim("◌") : red("✖");
    const partial = runs > 1 && r.pass > 0 && r.pass < runs ? dim(` (passed ${r.pass} of ${runs} runs)`) : "";
    const skipped = r.skipped ? dim(` (${r.skipped} run(s) skipped: the simulated user or judge failed)`) : "";
    const note = waiting ? (ok ? yellow(" (passes now: remove `pending`)") : dim(` (pending: ${waiting})`)) : "";
    console.log(`${mark} ${t.name}${partial}${skipped}${note}${tier === "always" && !waiting ? dim(" [always]") : ""}`);
    if (!ok && !waiting && r.fails[0]) {
      const why = r.fails[0].reason.split("\n").map((l) => l.trim()).filter(Boolean)[0] ?? "";
      console.log(dim(`    ${why.length > 160 ? `${why.slice(0, 159)}…` : why}   (create-evals show ${r.fails[0].trace})`));
    }
  }
  if (typeof f.report === "string") writeFileSync(path.resolve(root, f.report), JSON.stringify(report, null, 2) + "\n");
  const counted = tests.length - pending.length;
  const pass = counted - failed.length;
  console.log(`\n${bold(`${pass} of ${counted} pass.`)}${failed.length ? ` ${failed.length} fail${f.report ? "." : ": ask your coding agent to fix the agent until they pass, then run this again."}` : ""}${pending.length ? dim(` ${pending.length} pending.`) : ""}`);
  // Only "always" evals fail the process (for CI); the rest are reported.
  if (blocking && f.precommit) console.log(dim("Commit stopped: an eval that used to pass now fails. To commit anyway once: git commit --no-verify"));
  if (blocking) process.exit(1);
}

/** Real records → profiles, merged into profiles.json (same id: the imported one wins). */
function cmdImport(f: Flags) {
  const file = f._[1];
  if (!file) fail("Usage: create-evals import <file.jsonl|.json|.csv|-> [--input-field f] [--id-field f] [--agent a] [--kind chat|function] [--limit n]");
  if (f.kind !== undefined && !["chat", "function"].includes(String(f.kind))) fail(`--kind must be "chat" or "function", got "${f.kind}"`);
  const profiles = attempt(() =>
    toProfiles(readRecords(file === "-" ? "-" : path.resolve(root, file)), {
      agent: f.agent as string | undefined,
      inputField: f["input-field"] as string | undefined,
      idField: f["id-field"] as string | undefined,
      kind: f.kind as "chat" | "function" | undefined,
      limit: count(f, "limit", 200),
    }),
  );
  if (!profiles.length) fail(`No records in ${file}.`);
  const out = path.resolve(root, (f.out as string) || path.join(DIR, "profiles.json"));
  const existing = existsSync(out) ? readJson<{ profiles: Profile[] }>(out).profiles : [];
  const ids = new Set(profiles.map((p) => p.id));
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ profiles: [...existing.filter((p) => !ids.has(p.id)), ...profiles] }, null, 2) + "\n");
  const chats = profiles.filter((p) => p.input === undefined).length;
  const kinds = [profiles.length - chats && `${profiles.length - chats} inputs`, chats && `${chats} replayed conversations`].filter(Boolean).join(", ");
  console.log(green(`✔ ${profiles.length} profiles from ${file === "-" ? "stdin" : file} (${kinds}) → ${path.relative(root, out)}${existing.length ? `, alongside ${existing.filter((p) => !ids.has(p.id)).length} existing` : ""}`));
  console.log(dim(`Check one (they're named real-…), then: create-evals run --only ${profiles[0]!.id}`));
}

/**
 * Does a test have teeth? Run it today, then on a temp copy of the repo with one change (a rule deleted from the
 * prompt, a guard removed). A test that still passes without the rule isn't protecting it.
 */
async function cmdAblate(f: Flags) {
  const test = f.test;
  if (typeof test !== "string" || !test) fail('Usage: create-evals ablate --test "<name or part of it>" ((--remove "<exact text>" | --remove-file <file>) --in <file> | --patch <file.diff>) [--runs n]');
  // --remove-file: the exact text in a file, for rules that span lines (no shell quoting).
  if (typeof f["remove-file"] === "string") f.remove = readFileSync(path.resolve(root, f["remove-file"]), "utf8").replace(/\n$/, "");
  if (!f.patch && !(typeof f.remove === "string" && typeof f.in === "string")) fail("Say what to change: --remove \"<exact text>\" (or --remove-file <file>) --in <file>, or --patch <file.diff>.");
  const runs = String(count(f, "runs", 2));
  const copy = copyRepo(root);
  const cli = fileURLToPath(import.meta.url);
  const run = (cwd: string, label: string) => {
    const report = path.join(copy, `.ablate-${label}.json`);
    console.log(bold(`\n${label === "today" ? "Today" : "With the change"}:`));
    spawnSync(process.execPath, [...process.execArgv, cli, "test", "--only", test, "--runs", runs, "--report", report, ...(configPath ? ["--config", configPath] : [])], { cwd, stdio: "inherit" });
    return existsSync(report) ? (JSON.parse(readFileSync(report, "utf8")) as { name: string; passed: boolean; pass: number; runs: number }[]) : undefined;
  };
  try {
    try {
      if (f.patch) applyPatch(copy, String(f.patch));
      else removeText(copy, String(f.in), String(f.remove));
    } catch (e) {
      console.error(red(`✖ ${(e as Error).message}`));
      process.exitCode = 1;
      return;
    }
    const before = f["no-baseline"] ? undefined : run(root, "today");
    const after = run(copy, "changed");
    if (!after) {
      console.error(red("✖ The test run didn't finish (see above)."));
      process.exitCode = 1;
      return;
    }
    console.log();
    for (const t of after) {
      const was = before?.find((b) => b.name === t.name);
      if (was && !was.passed) console.log(yellow(`! ${t.name}: fails today too, so this says nothing. Make it pass first.`));
      else if (!t.passed) console.log(green(`✔ ${t.name}: has teeth. It fails without the change (${t.runs - t.pass} of ${t.runs} runs failed).`));
      else console.log(red(`✖ ${t.name}: no teeth. It still passes with the change, so it doesn't protect what was changed. Sharpen the input or the check.`));
    }
  } finally {
    if (f.keep) console.log(dim(`Kept the changed copy at ${copy}`));
    else rmSync(copy, { recursive: true, force: true });
  }
}

async function main() {
  const f = parse(process.argv.slice(2));
  if (f.version) return console.log(VERSION);
  if (typeof f.config === "string") configPath = f.config;
  // What create-evals' own model calls cost, after any command that made some.
  process.on("exit", () => {
    const line = usageLine();
    if (line && !f.json) console.log(dim(line));
  });
  const cmd = f._[0];
  if (f.help || cmd === "help") return console.log(HELP);
  if (!cmd || cmd === "setup") return cmdSetup(f);
  if (cmd === "find") return cmdFind(f);
  if (cmd === "init") return cmdInit(f);
  if (cmd === "list") return cmdList(f);
  if (cmd === "docs") return console.log(readFileSync(new URL("../docs/reference.md", import.meta.url), "utf8"));
  if (cmd === "check") return cmdCheck(f);
  if (cmd === "import") return cmdImport(f);
  if (cmd === "ablate") return cmdAblate(f);
  if (cmd === "run") return cmdRun(f);
  if (cmd === "review") return cmdReview(f);
  if (cmd === "group") return cmdGroup(f);
  if (cmd === "show") return cmdShow(f);
  if (cmd === "status") return cmdStatus();
  if (cmd === "drop") return cmdDrop(f);
  if (cmd === "reset") return cmdReset();
  if (cmd === "test") return cmdTest(f);
  if (cmd === "hook") return cmdHook();
  if (cmd === "ci") return cmdCi();
  fail(`Unknown command "${cmd}". Run create-evals --help.`);
}

main().catch((e) => fail(e?.stack ?? String(e)));
