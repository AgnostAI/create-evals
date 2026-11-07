## create-evals

When the developer asks for evals, agent tests, or "what does my agent get wrong" for the AI agent in this repo, follow these steps.

You're going to give the developer **about 10 evals**: concrete cases, each with a yes/no expected outcome that they confirm, and a command that tests them.

To find cases that matter, don't guess. Run the agent on many realistic cases, read what it actually did, and pick the ones that show what's broken (and a few things it gets right). The developer never sees that work. They see ~10 one-line cases, answer yes or no to each, and get their evals.

```
1 set up → 2 cases → 3 run, review, group → 4 pick ~10 cases → 5 developer answers y/n → 6 write the evals → 7 done (offer commit hook / CI)
                ▲                    │
                └─ found little: harder cases ─┘
```

`npx create-evals` gives you the tools: it runs the agent, reviews the runs, groups the problems, and runs the tests. You do what needs understanding this codebase.

Work in the repo root. `npx -y create-evals docs` prints the full reference (config, binding API, `scenario()`, `spawnSession()`, the Python helper), so you don't need to dig through the package. Run the CLI as `npx -y create-evals <command>`: nothing needs installing, not even in a Python repo (`import … from "create-evals"` in `evals/*.ts` resolves to the copy npx runs). create-evals reads `evals/create-evals.json` and `evals/agent.ts`, and keeps its working files in `.create-evals/` (gitignored).

### 1. Set up: run the agent like production, safely

Read the agent's code first: find the entry point production uses (route handler, CLI, worker, job), every tool and step, and what each one touches outside the process. Then decide its **shape** from what production sends in and gets back. Don't assume it's a chat:
- **Function:** input in, output out, no back-and-forth. Classifiers, triage, research, extraction, scoring, and **pipelines** of several LLM steps. Run `npx -y create-evals init --function`.
- **Chat:** a person talks to it over several turns (support bot, assistant, scheduler). Run `npx -y create-evals init`.

This writes `evals/agent.ts` (the binding) and `evals/create-evals.json` (the config). Install dependencies with the repo's own package manager (pnpm, yarn or npm, whichever lockfile it has), so you run the versions production runs.

**The binding** (`evals/agent.ts`) exports `defineAgent({ name, description, instructions, start })`:
- `description`: what the agent does, what it gets and who uses its output. The reviewer (and, for chats, simulated users) read this.
- `instructions`: repo-relative paths to the system prompt and policy files (or literal text), so the reviewer can judge the agent against its own rules.
- `start(ctx)`: starts one run (one input for a function, one conversation for a chat). It builds fresh state, and returns `{ send(message) → reply text, state() → end state }`.
  - **`send` must call the agent the way production does.** For a function, it receives the input as JSON text and returns the output as text. For a chat, it also keeps history the way production does: if production keeps tool calls between turns, keep them; if only text, only text. A different history is a different agent.
  - `ctx.record({ kind: "tool" | "state", name, input, output })` logs what happened, so the reviewer can check what the agent *said* against what it *did*. Record **both** the agent's own tool calls with their results (e.g. from the model's response parts) **and** every change your fakes make. With only one of them, reviewers misjudge: they can't tell whether the agent looked something up.
  - `state()` returns plain data describing what the agent changed: records, sent messages, files.
  - Per-run data goes on `ctx.state`. Code running inside the run (including fakes) reads it with `current()` from `create-evals`.

**What the tools touch.** Keep the agent's own code running, and fake only what's dangerous or what you need to control. For each external system, take the first option that works:
1. Harmless (read-only, public): leave it real, and add its host to `allowHosts`.
2. The vendor has a test version (Stripe test mode, a sandbox account, a staging DB, a temp folder or git repo, SQLite or PGlite): point the agent at it through env or config. Ask the developer for test credentials if needed.
3. Otherwise, write a small in-memory fake of the developer's own integration module, with the same exports, and swap it in: `"replace": { "src/google.ts": "evals/fake-google.ts" }`. The fake keeps state on `current().state`, records each change, and should behave like the real service (errors included). Never fake modules inside `node_modules`.
4. Last resort: wrap the tool's `execute` in the binding. Then the tool's own code isn't tested, so say so in the report.

Never change the agent's source to make it testable without asking the developer. If a bug blocks everything after it (a crash on every input), you can apply the one-line fix in an eval-only overlay config (`npx -y create-evals run --config evals/overlay.json`, with `replace` pointing at a patched copy) to explore further, and report the fix as finding #1.

**The config** (`evals/create-evals.json`):
- `replace`: modules to swap for fakes.
- `allowHosts`: hosts the agent may reach. Model APIs are always allowed; **everything else is blocked**, localhost included (add `"localhost"` for a local sandbox), and a blocked call fails loudly in the trace.
- `envFile`: the repo's env file, if it isn't `.env` at the root (e.g. `"backend/.env"`); `.env` is loaded by default. Point at it here rather than exporting keys by hand.
- `env`: variables set before the agent loads. `"${OTHER}"` references another variable, e.g. `"OPENAI_API_KEY": "${ANTHROPIC_API_KEY}"` with `"OPENAI_BASE_URL": "https://api.anthropic.com/v1/"` runs an OpenAI-SDK agent on Claude.
- `now`: an ISO time the clock starts at. Use it when the agent's behavior depends on dates.
- `concurrency`: set to 1 if runs would share state.

**Functions and pipelines.** Run `npx -y create-evals init --function`, and set `kind: "function"` and an `example` input in the binding. `send()` calls the function, records anything in between (model calls, which model answered), and returns the output with `JSON.stringify(output)`: a JSON reply is the end state too, so you don't need `state()`. Name the output fields that are decisions with `decisions: ["status", "relevant", "is_*"]`, so answers that flip between runs are reported on those fields and not on reworded text. For a **pipeline** (e.g. triage → account research → people → hooks):
- Bind it from its real entry point, so each case tests what production produces end to end.
- If the steps are separate agents with their own prompts, also bind each one: `defineAgent({ name, description, instructions, … })` per step, exported, and `export default defineAgents([triage, research])`. Don't write a dispatcher: each step is then reviewed against its own prompt, and `group` compares the steps against each other. Each case names its agent: `{ "id": "acme", "agent": "triage", "input": { … } }`.
- `ctx.record` each step's input and output (`{ kind: "tool", name: "triage", input, output }`), so the reviewer can see *which step* went wrong, and return the final output.
- If the whole pipeline takes minutes per input, bind the steps where the judgments happen and feed them realistic outputs of the steps before.
- Steps that call outside services (search, enrichment, CRMs, email) get fakes or sandboxes like any tool.

`npx -y create-evals list` shows all inputs and outputs side by side, which is where rates and outliers show up.

**Agents in another language** (Python, Go…). In a Python repo, check `pyproject.toml` first: with setuptools' automatic package discovery (no explicit `packages`), a top-level `evals/` folder can break `pip install -e .` ("Multiple top-level packages discovered"). If so, add `[tool.setuptools.packages.find] exclude = ["evals*"]` yourself (don't rename the folder), and mention it only if asked. The binding is still TypeScript, and the agent runs as a child process, one per run. In a Python repo, `init` writes both files for you:

```ts
// evals/agent.ts
import { defineAgent, spawnSession } from "create-evals";
export default defineAgent({
  name: "research-agent", description: "…", instructions: ["app/prompts.py"],
  start: (ctx) => spawnSession(ctx, [".venv/bin/python", "evals/run_agent.py"], { allowHosts: [] }),
});
```

```python
# evals/run_agent.py (create_evals.py ships with the package and is put on PYTHONPATH for you)
from create_evals import guard, record, serve
guard()                          # first: blocks every host except model APIs and allowHosts
from app.agent import Agent      # then import the real agent; fake what it calls here (monkeypatch)
agent = Agent()
serve(lambda message, profile: agent.reply(message), state=lambda: agent.snapshot())
```

The child reads `{"message", "profile"}` JSON lines and answers each with `@@CREATE_EVALS@@{"reply", "events", "state"}`. `create_evals.py` implements that for Python; any other language can do the same in a few lines. The repo root (and `src/`) is on the child's `PYTHONPATH`, so `from app.agent import …` works without `sys.path` edits. The Node sandbox doesn't reach the child, so call `guard()` before importing the app, swap out what the agent calls (monkeypatch the client or module), pin the clock there if dates matter, and use a temp database. With several agents, one runner can serve them all: `profile["agent"]` says which one a run is for.

**Awkward shapes:**
- *Only reachable through a CLI or server* (nothing exported, or the module starts a loop on import): `start()` spawns it as a child process and talks to it over stdin/stdout or HTTP. That's still the real agent.
- *Replies that are UI* (cards, forms, buttons): `send()` returns what the user would *see*, as text (e.g. "[flight card: SFO→JFK, 11:00 PM local]"). A form the user fills in becomes a message the simulated user can send.
- *A different model than production* (no key for it, or swapping on purpose): point it at the model you have through env or a replaced model module, and say so in the report. Failures that depend on the model need re-checking on the production one.
- *Your project isn't ESM:* that's fine; `create-evals` can be imported or required.
- *Files opened relative to the working directory* (a `./data.db`): set `"cwd"` in the config, or the agent may silently open an empty file.

**Framework notes:**
- *Claude's server tools* (web search, web fetch, code execution): they run inside the model call and come back as `server_tool_use` blocks, each paired with its result block by `tool_use_id`. Record each under its own block `name` with its `input`. Newer web search runs searches from code-execution blocks, so don't force those into a `web_search` shape. The reviewer believes what you record: a recorder that logs searches without their query turns into a "failure" that never happened. `check` warns about tool events with no input. Compare one recorded trace with the raw response before you run at scale.
- *Vercel AI SDK:* `result.response.messages` holds only the last step. Production history (and yours, if production keeps it) needs `result.steps.flatMap(s => s.response.messages)`. Record tool calls from each step's `content`: failed calls show up there as `tool-error` parts, not in `toolResults`.
- *Mastra:* give each conversation a fresh memory thread (a new `threadId`/`resource` per `start()`), so conversations don't leak into each other. Memory's message window (`lastMessages`) is production behavior; don't raise it for evals. A hard-coded model string can be overridden on the agent instance; say so in the report.
- *OpenAI Agents SDK:* carry `result.history` into the next `run()` if production does. Tool calls are in `result.newItems`.
- *LangGraph:* use a fresh `thread_id` per conversation (and a fresh store, if the graph keeps one), and keep the checkpointer production uses. When the graph pauses with `interrupt()`, the next `send()` resumes it with `new Command({ resume: message })`. Tool calls made inside subagents or tools don't show up in the top-level messages; record them with a callback handler (`handleToolStart`/`handleToolEnd`) passed in the run config.

Then:

```bash
npx -y create-evals check
```

This runs the `example` input (or, for a chat, one short conversation) and prints it, with every recorded event (`--message "…"` sends exactly that instead). Fix what it reports. Before moving on, confirm three things by reading the output:
- the agent's output is real;
- the events show its tool calls, steps and state changes;
- no request was blocked that should have been faked.

### 2. Cases: what this agent gets

**Real inputs first.** If the agent's real inputs already exist, replay them: production logs or traces (Agnost, Langfuse, your own logs), a database table of the items it processes, a queue export. Get them as JSONL, JSON or CSV (for a database, a read-only query you show the developer first), then:

```bash
npx -y create-evals import exports/items.jsonl --input-field payload --agent triage --limit 200
```

Each record becomes a function input, or, if it holds a `messages` list, a simulated user who replays its messages. If the logs hold something else (e.g. the rendered prompt rather than the function's arguments), write a short converter in any language that prints one input per line, and pipe it in: `python convert.py | npx -y create-evals import - --agent triage`. Keep the production outputs from the export too: comparing what the agent did in production with what it did in the run shows effects no reviewer can see (an item that never gets an output, batch after batch).

**Imports don't replace your own cases.** Real data covers what's common; the rules that matter often bite on what's rare. Always also write 10–15 cases in `.create-evals/profiles.json` from what you learned reading the code (more for a pipeline): the jobs the agent exists for, the situations around them, at least one for each explicit rule in the instructions, and each known hard case the developer has mentioned.

**A function or pipeline** gets inputs: realistic, varied, and aimed at where it must make a judgment.

```json
{ "profiles": [
  { "id": "series-d-uk-hq", "input": { "company": "Quill", "domain": "quill.io", "notes": "London HQ, US agent team in New York" } }
] }
```

**A chat** gets simulated people:

```json
{ "profiles": [
  { "id": "berlin-tuesday", "persona": "You're Lena Vogel (lena@kiteworks.example), a product lead in Berlin. You want 30 minutes with Shubham on Tuesday afternoon your time…", "setup": { "timeZone": "Europe/Berlin" }, "maxTurns": 8 }
] }
```

- `persona` is a realistic person: who they are, what they want, how they behave (patient, vague, pushy, changes their mind), and the details they know (names, emails, ids that exist in your fake's seed data). Write it in second person. `opening` (optional) fixes the first message.
- `setup` is passed to `start()` for anything agent-specific (which seed, a time zone, a world event to inject).

Ask these questions about *this* agent, and turn the answers into cases:
- Where is the call close (borderline inputs, missing data, sources that disagree, stale information)?
- What do inputs or users claim that the tools could check?
- Which rules live only in the prompt?
- What edges do its limits have (time zones, units, thresholds)?
- What can tools and earlier steps return besides success?
- Where does outside text end up, and can it give the agent instructions?
- What happens right before and after it commits an action (writes, sends, marks ready)?
- For chats: what must it remember across turns, who may cause each change, and what do users want that the rules forbid?

Most cases should be ordinary inputs doing ordinary things. Many real failures show up there, not in attacks.

### 3. Run, review, group

```bash
npx -y create-evals find        # = run + review + group
# or step by step:
npx -y create-evals run         # every case once; --repeat 3 to see variance; --only id,id
npx -y create-evals review      # a model reads each new trace and notes what went wrong, quoting evidence (--concurrency 12 for big runs)
npx -y create-evals group       # merges the notes into failure modes: .create-evals/failures.json
```

For functions and pipelines, run with `--repeat 3`: how often the answer flips is a finding. `group` and `list` show "Same input, different decisions" (e.g. `acme (triage, 3 runs): qualified: true 2/3, false 1/3`), and each failure mode's rate per input. Yes/no fields, status values and the binding's `decisions` count; free text never does, and labels or scores that moved are summarized on one line. A case that flips is a coin flip, not a bug that reproduces every time, so say so in its "today" ("today: yes 2 of 3"). With several agents (or function runs), `group` also lists **inconsistencies**: the same rule applied two ways, across agents (one step treats a company as a competitor, another step's prompt says it isn't) or across similar inputs. Those come from comparing runs; no single trace shows them.

Then do what the tools can't: **read**. `npx -y create-evals list` shows every run on one screen (with its end state); `list --json` gives you all of it to filter, so you don't need to write a script. Open at least the traces behind each failure mode with `npx -y create-evals show <trace-id>`, plus a few marked ok.
- Drop notes that are wrong: the reviewer misread something, or a bad input or the simulated user caused it.
- Look for what the reviewer can't see: failures caused by the instructions themselves (the agent obeys and the user still hits a dead end), and patterns that only show across many runs or across agents.
- Fix your fakes if *they* misbehaved, and re-run.
- If the reviewer missed something you can see, note it yourself. Things it can't see: characters that look the same (a non-breaking space against a normal one), outputs that come back empty in some runs (`list --json` → `output`), and counts (word or item limits): check those yourself.
- Several modes with one cause (the same limit seen from the prompt, the code and the output) are one problem: one case on the list.

Traces from setup mistakes or broken fakes shouldn't count: remove them with `npx -y create-evals drop <trace-id…>`. Start a clean round with `npx -y create-evals reset` (it archives the old one). When you regroup, new failure modes are marked `[new]`.

**If you found little, the cases were too easy.** Write a harder round aimed at what earlier runs never touched (tools or steps never exercised, rules never tested, closer calls, longer conversations, users who push back). Run, review and group again. Two or three rounds is normal. Stop when a new round finds nothing new, not when time runs out; a pipeline takes longer than a single agent.

### 4. Pick about 10 cases

From what you found, choose **about 10 cases** (8–12):
- **One case per real problem,** most important first, using its clearest example from the runs.
- **2–3 things the agent gets right** that matter, so they stay right.

Sort each case into one of two kinds:
- **Clear bug:** the agent defeats its own intent: data silently lost or blanked, output thrown away, a crash, a limit in the prompt that the code enforces differently. The answer is obvious; fill it in.
- **Your call:** the instructions don't settle it, or settle it in a way the developer might not mean (a policy, a threshold, an exception).

Write each as **one line**:
- **The situation,** in plain words with the specific detail that matters ("Podium: US lead Walker Ward, his LinkedIn says United States").
- **A yes/no question about the outcome:** "Should it qualify?", "Should it book the meeting?", "Mark ready to contact?". Ask what should *happen*, never "is this reply OK?".
- **What the agent did today,** in a word or two ("today: no", "today: yes 2 of 3").
- For a clear bug, **the answer, marked**: "→ yes (bug)".

No code, file paths, field names or causes in this list.

### 5. The developer answers

Show the list in one message, exactly in this shape:

```
I ran your <agent> on <N> cases. Here are the <K> that matter.
For each, answer: should this happen?

 1. Quill: hiring an AI product lead; the opener runs 13 words.       Should it get an opener?   → yes (bug)   today: no
 2. Podium: US lead Walker Ward, his LinkedIn says "United States".   Should it qualify?        today: no
 3. Cresta: sells "AI Agent Testing 2.0" (a competitor).              Should it qualify?        today: yes
 4. Citi: public, ~219,000 people, no funding round.                  Should it qualify?        today: no
 …

Reply like: 2y 3n 4y … (1 is a bug, answered already: reply only if you disagree)
```

Bugs go first. Their answers are the expected outcome of each eval; a filled-in bug answer stands unless they change it. A policy question (Citi) takes a moment's thought: never answer those for them. If they ask about a number, explain that one case in two or three plain sentences, then wait. If they say "it depends", split it into two cases that differ in exactly that detail.

### 6. Write the evals

**One test per case,** named after its line, checking the outcome they chose:

```ts
import assert from "node:assert/strict";
import { scenario } from "create-evals";
import agent from "./agent.js";

scenario(agent, "1. Podium (US lead, LinkedIn says United States) qualifies", {
  input: podium,                       // a chat: profile: { persona: "…", maxTurns: 6 }
  runs: 2,
  check({ state }) {
    assert.equal(state.passed, true, "Podium should qualify");
  },
});
```

- **Check the outcome directly:** the end state or the output field first, then what the agent said. Use `expectJudge` only when the text is the outcome.
- **Each eval must match today's behavior:** where the agent's behavior differs from their answer, the eval fails today; where it matches, it passes. Run `npx -y create-evals test` and check. A case that should fail but passes needs a sharper input. Use `runs: 2` (or 3 if the agent is flaky).
- **Every eval also fails on crashes, empty replies and blocked network calls** automatically.
- **With several agents,** import the one the eval is about: `import { triage } from "./agent.js"`.
- **An eval that needs the output to change shape first** (a field the agent doesn't produce yet): write it against the shape you expect and add `pending: "needs triage to output a roundup field"`. It runs and shows as `◌`, never counts as a failure, and `test` tells you when it starts passing.
- **An eval that guards a rule in the prompt must fail without that rule.** Check it: `npx -y create-evals ablate --test "<eval name>" --remove "<the rule's exact text>" --in <prompt file>` runs the eval today and on a temp copy without the rule, and says whether it has teeth. If it has none, sharpen the input or the check.
- **Inputs:** inline them in the test, or keep larger ones (payloads, seed data, fake pages) under `evals/fixtures/`. `.create-evals/` is scratch and gitignored.

Write `evals/evals.md` as the same list, so anyone can read and edit it:

```markdown
# Evals: research agent
Run: `npx create-evals test`

| # | Case | Should | Today |
|---|---|---|---|
| 1 | Podium: US lead Walker Ward, LinkedIn says "United States" | qualify: yes | ✗ no |
| 2 | Cresta: sells "AI Agent Testing 2.0" | qualify: no | ✗ yes |
| 4 | Toyota: only its headquarters is in the US | US team: no | ✓ no |
```

**Protect what works:** add `tier: "always"` to every eval that passes today. Only those can block a commit or CI later; failing ones are known bugs and never block. When an eval starts passing after a fix, mark it `always` too.

Touch nothing else in their project: no package.json scripts, hooks or CI unless they ask (step 7).

### 7. Done

End with exactly this, and nothing else (no notes before or after it):

```
✔ 10 evals created in evals/ (listed in evals/evals.md)
  Today 6 pass and 4 fail: 1, 2, 3 and 6. Those are bugs in your agent.
  Run anytime: npx create-evals test
  Next: ask me to fix the 4 failing evals.

Want the 6 passing evals to run automatically? Reply: commit (before each commit), ci (GitHub Actions), both, or no.
```

On "commit", run `npx -y create-evals hook`; on "ci", run `npx -y create-evals ci` (both on "both"). If it prints `!`, do what it says (e.g. add the line to their pre-commit config). For CI, make the workflow's install step match how this repo installs (it's a guess from the lockfiles). Don't commit or push. Then reply in one or two lines: what now runs when, and for CI, that they need to add `ANTHROPIC_API_KEY` to their GitHub secrets.

Causes, file paths, how things are faked, and costs are for when they ask. If they ask you to fix the failing evals: fix the agent (not the evals), mark each newly passing eval `always`, run `npx -y create-evals test` again, and report the new count in the same format.

### Reference

| Command | What it does |
|---|---|
| `create-evals init [--function] [--python]` | Scaffold `evals/agent.ts` (chat or function; plus `evals/run_agent.py` in a Python repo) and `evals/create-evals.json` |
| `create-evals check [--agent a]` | Runs the `example` input (or one short conversation) for each agent; verifies the setup |
| `create-evals import <file\|-> [--input-field f] [--agent a]` | Real records (JSONL, JSON, CSV, or a converter on stdin) → cases |
| `create-evals run [--profiles f] [--only a,b] [--repeat n] [--agent a]` | Every case → `.create-evals/traces/` |
| `create-evals review [--all] [--model m] [--concurrency n]` | Notes per trace (problems with quoted evidence) |
| `create-evals group [--model m] [--no-consistency]` | Failure modes, inconsistencies across agents and inputs, and answers that flip → `.create-evals/failures.json` |
| `create-evals show <trace-id> [--full]` | One run with its events, end state and review |
| `create-evals drop <trace-id…>` | Delete traces that shouldn't count |
| `create-evals reset` | Archive this round's traces and failures; start fresh |
| `create-evals test [files] [--runs n] [--tier always] [--only text] [--precommit]` | Run `evals/*.eval.ts` (`--precommit`: the `always` evals, one run each, skipped without a key) |
| `create-evals ablate --test t --remove "text" --in file` | Does an eval have teeth? Runs it with the change on a temp copy |
| `create-evals hook` | Pre-commit hook running the `always` evals (only if the developer asks) |
| `create-evals ci` | `.github/workflows/evals.yml` running the `always` evals (only if the developer asks) |
| `create-evals list [--json]` | Every run on one screen: input, outcome, output, problems, answers that flip |
| `create-evals status` | Counts of traces, reviews and failure modes |

**Models.** The reviewer, grouping and (for chats) simulated users default to `claude-sonnet-5-5`. Override them with `--model`, `--user-model`, the config's `models`, or `CREATE_EVALS_{USER,REVIEW,GROUP,JUDGE}_MODEL`. OpenAI models work with `OPENAI_API_KEY`.
