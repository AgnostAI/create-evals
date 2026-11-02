#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentDefinition } from "./agent.js";
import { DEFAULT_MODELS } from "./llm.js";
import { CONFIG_PATH, DIR, loadAgent, loadConfig, prepare, readInstructions, type Config } from "./project.js";
import { group, review } from "./review.js";
import { converse, converseAll } from "./run.js";
import { blocked } from "./sandbox.js";
import { registered, setCurrentFile, type Registered } from "./scenario.js";
import { render } from "./trace.js";
import type { FailureMode, Profile, Trace } from "./types.js";

const VERSION = "1.0.0-alpha.0";
const tty = process.stdout.isTTY;
const c = (code: number) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const [bold, dim, red, green, yellow] = [c(1), c(2), c(31), c(32), c(33)];

const HELP = `${bold("create-evals")} ${VERSION}: find your agent's real failures and turn each one into a test.

  create-evals init                 scaffold evals/agent.ts and ${CONFIG_PATH}
  create-evals check                run one short conversation to prove the setup works
  create-evals run [--profiles f] [--only id,id] [--repeat n]
                                    run simulated users against the agent; saves traces
  create-evals review [--all]       read each new trace and note what the agent did wrong
  create-evals group                merge the notes into failure modes (${DIR}/failures.json)
  create-evals show <trace-id>      print a conversation and its review
  create-evals test [files] [--runs n] [--tier always]
                                    run the tests in evals/*.eval.ts
  create-evals status               what's been run, reviewed and grouped

Options: --model <id> (review/group), --user-model <id>, --concurrency <n>
Docs: https://github.com/AgnostAI/create-evals`;

interface Flags {
  _: string[];
  [k: string]: string | boolean | string[];
}

function parse(argv: string[]): Flags {
  const f: Flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) f._.push(a);
    else if (["--all", "--help", "--version"].includes(a)) f[a.slice(2)] = true;
    else f[a.slice(2)] = argv[++i] ?? "";
  }
  return f;
}

const root = process.cwd();
const dir = (...p: string[]) => path.join(root, DIR, ...p);
const tracesDir = () => dir("traces");

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

function saveTrace(t: Trace) {
  mkdirSync(tracesDir(), { recursive: true });
  writeFileSync(path.join(tracesDir(), `${t.id}.json`), JSON.stringify(t, null, 2) + "\n");
}

function allTraces(): Trace[] {
  if (!existsSync(tracesDir())) return [];
  return readdirSync(tracesDir())
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(path.join(tracesDir(), f), "utf8")) as Trace)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

async function setup(): Promise<{ config: Config; agent: AgentDefinition }> {
  const config = loadConfig(root);
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
        // Call the agent exactly as production does, keeping the full history (tool calls included).
        // Record tool calls so the reviewer can check what the agent said against what it did:
        // ctx.record({ kind: "tool", name, input, output });
        throw new Error("evals/agent.ts: implement send()");
      },
      // What the agent changed, for the reviewer and tests:
      // state: () => ctx.state.db.snapshot(),
    };
  },
});
`;

function cmdInit() {
  mkdirSync(path.join(root, "evals"), { recursive: true });
  const files: [string, string][] = [
    ["evals/agent.ts", AGENT_TEMPLATE],
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

async function cmdCheck() {
  const { agent } = await setup();
  const profile: Profile = {
    id: "check",
    persona: `You're trying this agent for the first time. Ask one realistic, simple question it's meant to handle. Then ask one follow-up that depends on its previous answer. Then stop.`,
    maxTurns: 2,
  };
  console.log(dim(`Running one short conversation with ${agent.name}…`));
  const t = await converse(agent, profile, { userModel: DEFAULT_MODELS.user });
  saveTrace(t);
  console.log(render(t));
  console.log();
  const problems: string[] = [];
  const agentTurns = t.turns.filter((x) => x.role === "agent");
  if (t.ended === "agent-error") problems.push(`The agent threw: ${t.error}`);
  if (agentTurns.length < 2 && t.ended !== "agent-error") problems.push("The conversation ended before a second turn.");
  if (agentTurns.some((x) => !x.text.trim())) problems.push("An agent reply was empty: does send() return the reply text?");
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
  const file = path.join(root, (f.profiles as string) || path.join(DIR, "profiles.json"));
  let profiles = readJson<{ profiles: Profile[] }>(file).profiles;
  if (f.only) {
    const only = String(f.only).split(",");
    profiles = profiles.filter((p) => only.includes(p.id));
  }
  const repeat = Number(f.repeat ?? 1);
  const queue = profiles.flatMap((p) => Array.from({ length: repeat }, () => p));
  if (!queue.length) fail("No profiles to run.");
  console.log(dim(`Running ${queue.length} conversation(s) with ${agent.name}…`));
  const traces = await converseAll(agent, queue, {
    concurrency: Number(f.concurrency ?? config.concurrency ?? 4),
    userModel: (f["user-model"] as string) || config.models?.user || DEFAULT_MODELS.user,
    onDone: (t) => {
      saveTrace(t);
      console.log(line(t));
    },
  });
  const flagged = traces.filter((t) => t.checks.length || t.ended === "agent-error").length;
  console.log(`\n${traces.length} traces saved to ${DIR}/traces/${flagged ? `, ${yellow(`${flagged} with basic-check findings`)}` : ""}. Next: create-evals review`);
}

async function cmdReview(f: Flags) {
  const { config, agent } = await setup();
  const modelId = (f.model as string) || config.models?.review || DEFAULT_MODELS.review;
  const todo = allTraces().filter((t) => f.all || !t.review);
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
  console.log(`\n${withProblems}/${todo.length} conversations had problems. Next: create-evals group`);
}

async function cmdGroup(f: Flags) {
  const { config, agent } = await setup();
  const modelId = (f.model as string) || config.models?.group || DEFAULT_MODELS.group;
  const traces = allTraces();
  const reviewed = traces.filter((t) => t.review);
  if (!reviewed.length) fail("No reviewed traces. Run `create-evals review` first.");
  const modes = await group(reviewed, agent.description, modelId);
  writeFileSync(dir("failures.json"), JSON.stringify({ reviewed: reviewed.length, modes }, null, 2) + "\n");
  if (!modes.length) return console.log(green(`No problems found in ${reviewed.length} conversations. Make the profiles harder and run again.`));
  console.log(bold(`${modes.length} failure mode(s) across ${reviewed.length} reviewed conversations:\n`));
  for (const m of modes) printMode(m, reviewed.length);
  console.log(dim(`Saved to ${DIR}/failures.json. Show the developer each mode with a transcript (create-evals show <trace>) and ask: bug, or acceptable?`));
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
  const t = allTraces().find((x) => x.id === id || x.id.startsWith(id));
  if (!t) fail(`No trace ${id}`);
  console.log(bold(`${t.id}`) + dim(`  persona: ${t.profile.persona.slice(0, 200)}`));
  console.log(render(t));
  if (t.checks.length) console.log(`\n${yellow("Basic checks:")} ${t.checks.map((x) => `${x.check} (${x.detail})`).join("; ")}`);
  if (t.review) {
    console.log(`\n${bold("Review")} ${dim(t.review.model)}: ${t.review.summary}`);
    for (const p of t.review.problems) console.log(`  [${p.severity}] turn ${p.turn}: ${p.what}\n    "${p.evidence}"`);
    if (t.review.simulatorIssues.length) console.log(dim(`  simulator: ${t.review.simulatorIssues.join("; ")}`));
  }
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
  const files = f._.length > 1 ? f._.slice(1) : existsSync(path.join(root, "evals")) ? readdirSync(path.join(root, "evals")).filter((x) => /\.eval\.[cm]?[jt]s$/.test(x)).map((x) => `evals/${x}`) : [];
  if (!files.length) fail("No evals/*.eval.ts files.");
  for (const file of files) {
    setCurrentFile(file);
    await import(pathToFileURL(path.join(root, file)).href);
  }
  let tests = registered();
  if (f.tier) tests = tests.filter((t) => (t.opts.tier ?? "usually") === f.tier);
  if (f.only) tests = tests.filter((t) => t.name.includes(String(f.only)));
  const runsOverride = f.runs ? Number(f.runs) : process.env.CREATE_EVALS_RUNS ? Number(process.env.CREATE_EVALS_RUNS) : undefined;
  const userModel = (f["user-model"] as string) || config.models?.user || DEFAULT_MODELS.user;
  console.log(dim(`Running ${tests.length} test(s)…`));

  const jobs = tests.flatMap((t) => Array.from({ length: runsOverride ?? t.opts.runs ?? 1 }, (_, i) => ({ t, i })));
  const results = new Map<Registered, { pass: number; fails: { reason: string; trace: string }[] }>();
  const queue = [...jobs];
  await Promise.all(
    Array.from({ length: Number(f.concurrency ?? config.concurrency ?? 4) }, async () => {
      for (let job = queue.shift(); job; job = queue.shift()) {
        const { t } = job;
        const r = results.get(t) ?? { pass: 0, fails: [] };
        results.set(t, r);
        const profile = { id: t.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40), ...t.opts.profile } as Profile;
        const trace = await converse(t.agent, profile, { userModel });
        trace.id = `test-${trace.id}`;
        saveTrace(trace);
        try {
          const bad = trace.checks.filter((x) => !(t.opts.allow ?? []).includes(x.check));
          if (trace.ended === "user-error") throw new Error(trace.error);
          if (bad.length) throw new Error(`basic check: ${bad.map((x) => `${x.check} (${x.detail})`).join("; ")}`);
          const transcript = render(trace);
          const said = trace.turns.filter((x) => x.role === "agent").map((x) => x.text).join("\n");
          await t.opts.check?.({ trace, state: trace.state, transcript, said });
          r.pass++;
        } catch (e) {
          r.fails.push({ reason: (e as Error).message.split("\n")[0]!.slice(0, 300), trace: trace.id });
        }
      }
    }),
  );

  let blocking = 0;
  for (const t of tests) {
    const r = results.get(t)!;
    const runs = r.pass + r.fails.length;
    const tier = t.opts.tier ?? "usually";
    const need = t.opts.atLeast ?? (tier === "always" ? runs : Math.ceil((runs * 2) / 3));
    const ok = r.pass >= need;
    if (!ok && tier === "always") blocking++;
    const mark = ok ? green("✔") : tier === "always" ? red("✖") : yellow("~");
    console.log(`${mark} ${t.name} ${dim(`(${r.pass}/${runs}, ${tier}, ${t.file})`)}`);
    for (const fl of r.fails.slice(0, 2)) console.log(dim(`    ${fl.reason}\n    → create-evals show ${fl.trace}`));
  }
  const failing = tests.filter((t) => {
    const r = results.get(t)!;
    const runs = r.pass + r.fails.length;
    return r.pass < (t.opts.atLeast ?? ((t.opts.tier ?? "usually") === "always" ? runs : Math.ceil((runs * 2) / 3)));
  }).length;
  console.log(`\n${tests.length - failing}/${tests.length} passing${failing ? `, ${failing} failing (${blocking} blocking: tier "always")` : ""}`);
  // Only "always" tests block (CI). "usually" failures are reported but don't fail the run.
  if (blocking) process.exit(1);
}

async function main() {
  const f = parse(process.argv.slice(2));
  if (f.version) return console.log(VERSION);
  const cmd = f._[0];
  if (!cmd || f.help) return console.log(HELP);
  if (cmd === "init") return cmdInit();
  if (cmd === "check") return cmdCheck();
  if (cmd === "run") return cmdRun(f);
  if (cmd === "review") return cmdReview(f);
  if (cmd === "group") return cmdGroup(f);
  if (cmd === "show") return cmdShow(f);
  if (cmd === "status") return cmdStatus();
  if (cmd === "test") return cmdTest(f);
  fail(`Unknown command "${cmd}". Run create-evals --help.`);
}

main().catch((e) => fail(e?.stack ?? String(e)));
