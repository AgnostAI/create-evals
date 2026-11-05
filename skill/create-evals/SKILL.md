---
name: create-evals
description: Give an AI agent about 10 evals built from what it actually gets wrong. Runs the agent in this repo against realistic cases (with its tools pointed at fakes or sandboxes), reads what happened, then shows the developer ~10 concrete cases to answer yes or no, and turns their answers into tests. Use when the user asks for evals, agent tests, "what does my agent get wrong", or regression tests for an LLM agent.
---

# create-evals

You're going to give the developer **about 10 evals**: concrete cases, each with a yes/no expected outcome that they confirm, and a command that tests them.

To find cases that matter, don't guess. Run the agent on many realistic cases, read what it actually did, and pick the ones that show what's broken (and a few things it gets right). The developer never sees that work. They see ~10 one-line cases, answer yes or no to each, and get their evals.

```
1 set up → 2 profiles → 3 run, review, group → 4 pick ~10 cases → 5 developer answers y/n → 6 write the evals → 7 done
                ▲                    │
                └─ found little: harder cases ─┘
```

`npx create-evals` gives you the tools: it runs the agent, reviews the runs, groups the problems, and runs the tests. You do what needs understanding this codebase.

Work in the repo root. `npx -y create-evals docs` prints the full reference (config, binding API, `scenario()`, `spawnSession()`, the Python helper), so you don't need to dig through the package. Run the CLI as `npx -y create-evals <command>`: nothing needs installing, not even in a Python repo (`import … from "create-evals"` in `evals/*.ts` resolves to the copy npx runs). create-evals reads `evals/create-evals.json` and `evals/agent.ts`, and keeps its working files in `.create-evals/` (gitignored).

## 1. Set up: run the agent like production, safely

```bash
npx -y create-evals init
```

This writes `evals/agent.ts` (the binding) and `evals/create-evals.json` (the config). Install dependencies with the repo's own package manager (pnpm, yarn or npm, whichever lockfile it has), so you run the versions production runs. Read the agent's code first: find the entry point production uses (the route handler, CLI, or worker), how it keeps conversation history, every tool, and what each tool touches outside the process.

**The binding** (`evals/agent.ts`) exports `defineAgent({ name, description, instructions, start })`:
- `description`: what the agent does and who talks to it. Simulated users and the reviewer read this.
- `instructions`: repo-relative paths to the system prompt and policy files (or literal text), so the reviewer can judge the agent against its own rules.
- `start(ctx)`: starts one conversation. It builds fresh state, and returns `{ send(message) → reply text, state() → end state }`.
  - **`send` must call the agent the way production does, and keep history the way production does.** If production keeps tool calls between turns, keep them; if it keeps only text, keep only text. A different history is a different agent, and history bugs are among the most common real failures.
  - `ctx.record({ kind: "tool" | "state", name, input, output })` logs what happened, so the reviewer can check what the agent *said* against what it *did*. Record **both** the agent's own tool calls with their results (e.g. from the model's response parts) **and** every change your fakes make. With only one of them, reviewers misjudge: they can't tell whether the agent looked something up.
  - `state()` returns plain data describing what the agent changed: records, sent messages, files.
  - Per-conversation data goes on `ctx.state`. Code running inside the conversation (including fakes) reads it with `current()` from `create-evals`.

**What the tools touch.** Keep the agent's own code running, and fake only what's dangerous or what you need to control. For each external system, take the first option that works:
1. Harmless (read-only, public): leave it real, and add its host to `allowHosts`.
2. The vendor has a test version (Stripe test mode, a sandbox account, a staging DB, a temp folder or git repo, SQLite or PGlite): point the agent at it through env or config. Ask the developer for test credentials if needed.
3. Otherwise, write a small in-memory fake of the developer's own integration module, with the same exports, and swap it in: `"replace": { "src/google.ts": "evals/fake-google.ts" }`. The fake keeps state on `current().state`, records each change, and should behave like the real service (errors included). Never fake modules inside `node_modules`.
4. Last resort: wrap the tool's `execute` in the binding. Then the tool's own code isn't tested, so say so in the report.

Never change the agent's source to make it testable without asking the developer. If a bug blocks everything after it (a crash on every turn), you can apply the one-line fix in an eval-only overlay config (`npx -y create-evals run --config evals/overlay.json`, with `replace` pointing at a patched copy) to explore further, and report the fix as finding #1.

**The config** (`evals/create-evals.json`):
- `replace`: modules to swap for fakes.
- `allowHosts`: hosts the agent may reach. Model APIs are always allowed; **everything else is blocked**, localhost included (add `"localhost"` for a local sandbox), and a blocked call fails loudly in the trace.
- `env`: variables set before the agent loads. `"${OTHER}"` references another variable, e.g. `"OPENAI_API_KEY": "${ANTHROPIC_API_KEY}"` with `"OPENAI_BASE_URL": "https://api.anthropic.com/v1/"` runs an OpenAI-SDK agent on Claude.
- `now`: an ISO time the clock starts at. Use it when the agent's behavior depends on dates.
- `concurrency`: set to 1 if conversations would share state.

**Agents that aren't chats** (classifiers, triage, extractors, pipelines: one input → one output) use the same loop. Run `npx -y create-evals init --function`, and set `kind: "function"` plus an `example` input in the binding. Profiles are `{ "id": "...", "input": { ...any JSON... } }`, with no persona. `send()` receives the input as JSON text, calls the function, records anything in between (model calls, which model answered), and returns the output as text for the reviewer. Write the inputs yourself: realistic, varied, and aimed at where the function must make a judgment. `npx -y create-evals list` shows all inputs and outputs side by side, which is where rates and outliers show up.

**Agents in another language** (Python, Go…). In a Python repo, check `pyproject.toml` first: with setuptools' automatic package discovery (no explicit `packages`), a top-level `evals/` folder can break `pip install -e .` ("Multiple top-level packages discovered"). If so, tell the developer, and suggest excluding it (`[tool.setuptools.packages.find] exclude = ["evals*"]`) rather than renaming. The binding is still TypeScript, and the agent runs as a child process, one per conversation:

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

The child reads `{"message", "profile"}` JSON lines and answers each with `@@CREATE_EVALS@@{"reply", "events", "state"}`. `create_evals.py` implements that for Python; any other language can do the same in a few lines. The Node sandbox doesn't reach the child, so call `guard()` before importing the app, swap out what the agent calls (monkeypatch the client or module), pin the clock there if dates matter, and use a temp database.

**Awkward shapes:**
- *Only reachable through a CLI or server* (nothing exported, or the module starts a loop on import): `start()` spawns it as a child process and talks to it over stdin/stdout or HTTP. That's still the real agent.
- *Replies that are UI* (cards, forms, buttons): `send()` returns what the user would *see*, as text (e.g. "[flight card: SFO→JFK, 11:00 PM local]"). A form the user fills in becomes a message the simulated user can send.
- *A different model than production* (no key for it, or swapping on purpose): point it at the model you have through env or a replaced model module, and say so in the report. Failures that depend on the model need re-checking on the production one.
- *Your project isn't ESM:* that's fine; `create-evals` can be imported or required.
- *Files opened relative to the working directory* (a `./data.db`): set `"cwd"` in the config, or the agent may silently open an empty file.

**Framework notes:**
- *Vercel AI SDK:* `result.response.messages` holds only the last step. Production history (and yours, if production keeps it) needs `result.steps.flatMap(s => s.response.messages)`. Record tool calls from each step's `content`: failed calls show up there as `tool-error` parts, not in `toolResults`.
- *Mastra:* give each conversation a fresh memory thread (a new `threadId`/`resource` per `start()`), so conversations don't leak into each other. Memory's message window (`lastMessages`) is production behavior; don't raise it for evals. A hard-coded model string can be overridden on the agent instance; say so in the report.
- *OpenAI Agents SDK:* carry `result.history` into the next `run()` if production does. Tool calls are in `result.newItems`.
- *LangGraph:* use a fresh `thread_id` per conversation (and a fresh store, if the graph keeps one), and keep the checkpointer production uses. When the graph pauses with `interrupt()`, the next `send()` resumes it with `new Command({ resume: message })`. Tool calls made inside subagents or tools don't show up in the top-level messages; record them with a callback handler (`handleToolStart`/`handleToolEnd`) passed in the run config.

Then:

```bash
npx -y create-evals check
```

This runs one short conversation and prints it, with every recorded event (`--message "…"` sends exactly one message instead). Fix what it reports. Before moving on, confirm three things by reading the output:
- the agent's replies are real;
- the events show its tool calls and state changes;
- no request was blocked that should have been faked.

## 2. Profiles: who talks to this agent

Write `.create-evals/profiles.json`:

```json
{ "profiles": [
  { "id": "berlin-tuesday", "persona": "You're Lena Vogel (lena@kiteworks.de), a product lead in Berlin. You want 30 minutes with Shubham on Tuesday afternoon your time…", "setup": { "timeZone": "Europe/Berlin" }, "maxTurns": 8 }
] }
```

- `persona` is a realistic person: who they are, what they want, how they behave (patient, vague, pushy, changes their mind), and the details they know (names, emails, ids that exist in your fake's seed data). Write it in second person.
- `setup` is passed to `start()` for anything agent-specific (which seed, the user's time zone, a world event to inject).
- `opening` (optional) fixes the first message.

Write 10–15 profiles from what you learned reading the code. Cover the jobs the agent exists for, then the situations around them. Ask these questions about *this* agent, and turn the answers into people:
- What do users claim that the tools could check?
- Who is allowed to cause each change, and how does the agent know who it's talking to?
- Which rules live only in the prompt?
- What edges do its limits have (in the user's terms: their time zone, their units)?
- What must the agent remember across turns?
- What happens right before and after it commits an action ("yes, do it", a change of mind, "did it go through?")?
- What can tools return besides success?
- Where does user or tool text end up?
- What do users want that the rules forbid?

Most profiles should be ordinary users doing ordinary things over several turns. Many real failures show up there, not in attacks.

## 3. Run, review, group

```bash
npx -y create-evals find        # = run + review + group
# or step by step:
npx -y create-evals run         # every profile once; --repeat 2 to see variance; --only id,id
npx -y create-evals review      # a model reads each new trace and notes what went wrong, quoting evidence
npx -y create-evals group       # merges the notes into failure modes: .create-evals/failures.json
```

Then do what the tools can't: **read**. `npx -y create-evals list` shows every run on one screen (with its end state); `list --json` gives you all of it to filter, so you don't need to write a script. Open at least the traces behind each failure mode with `npx -y create-evals show <trace-id>`, plus a few marked ok.
- Drop notes that are wrong: the reviewer misread something, or the simulated user caused it.
- Look for what the reviewer can't see: failures caused by the instructions themselves (the agent obeys and the user still hits a dead end), and patterns that only show across many conversations.
- Fix your fakes if *they* misbehaved, and re-run.
- If the reviewer missed something you can see, note it yourself.

Traces from setup mistakes or broken fakes shouldn't count: remove them with `npx -y create-evals drop <trace-id…>`. Start a clean round with `npx -y create-evals reset` (it archives the old one). When you regroup, new failure modes are marked `[new]`.

**If you found little, the profiles were too easy.** Write a harder round aimed at what earlier runs never touched (tools never called, rules never tested, longer conversations, users who push back). Run, review and group again. Two or three rounds is normal. Stop when a new round finds nothing new.

## 4. Pick about 10 cases

From what you found, choose **about 10 cases** (8–12):
- **One case per real problem,** most important first, using its clearest example from the runs.
- **2–3 things the agent gets right** that matter, so they stay right.

Write each as **one line**:
- **The situation,** in plain words with the specific detail that matters ("Podium: US lead Walker Ward, his LinkedIn says United States").
- **A yes/no question about the outcome:** "Should it qualify?", "Should it book the meeting?", "Mark ready to contact?". Ask what should *happen*, never "is this reply OK?".
- **What the agent did today,** in a word or two ("today: no", "today: crashes 2 of 3").

No code, file paths, field names or causes in this list.

## 5. The developer answers

Show the list in one message, exactly in this shape:

```
I ran your <agent> on <N> cases. Here are the <K> that matter.
For each, answer: should this happen?

 1. Podium: US lead Walker Ward, his LinkedIn says "United States".   Should it qualify?        today: no
 2. Cresta: sells "AI Agent Testing 2.0" (a competitor).              Should it qualify?        today: yes
 3. Citi: public, ~219,000 people, no funding round.                  Should it qualify?        today: no
 …

Reply like: 1y 2n 3y …
```

Their answer is the expected outcome of each eval. A clear bug takes them a second; a policy question (Citi) takes a moment's thought. Never answer for them. If they ask about a number, explain that one case in two or three plain sentences, then wait. If they say "it depends", split it into two cases that differ in exactly that detail.

## 6. Write the evals

**One test per case,** named after its line, checking the outcome they chose:

```ts
import assert from "node:assert/strict";
import { scenario } from "create-evals";
import agent from "./agent.js";

scenario(agent, "1. Podium (US lead, LinkedIn says United States) qualifies", {
  profile: { input: podium },          // a chat agent: { persona: "…", maxTurns: 6 }
  runs: 2,
  check({ state }) {
    assert.equal(state.passed, true, "Podium should qualify");
  },
});
```

- **Check the outcome directly:** the end state or the output field first, then what the agent said. Use `expectJudge` only when the text is the outcome.
- **Each eval must match today's behavior:** where the agent's behavior differs from their answer, the eval fails today; where it matches, it passes. Run `npx -y create-evals test` and check. A case that should fail but passes needs a sharper input. Use `runs: 2` (or 3 if the agent is flaky).
- **Every eval also fails on crashes, empty replies and blocked network calls** automatically.
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

If the repo has a package.json, add `"evals": "npx -y create-evals test"` to its scripts.

## 7. Done

End with exactly this, and nothing else:

```
✔ 10 evals created in evals/ (listed in evals/evals.md)
  Today 6 pass and 4 fail: 1, 2, 3 and 6. Those are bugs in your agent.
  Run anytime: npx create-evals test
  Next: ask your coding agent to fix the 4 failing evals.
```

Causes, file paths, how things are faked, and costs are for when they ask. If they ask you to fix the failing evals: fix the agent (not the evals), run `npx -y create-evals test` again, and report the new count in the same format.

## Reference

| Command | What it does |
|---|---|
| `create-evals init [--function]` | Scaffold `evals/agent.ts` (chat or function) and `evals/create-evals.json` |
| `create-evals check` | One short conversation; verifies the setup |
| `create-evals run [--profiles f] [--only a,b] [--repeat n]` | Conversations → `.create-evals/traces/` |
| `create-evals review [--all] [--model m]` | Notes per trace (problems with quoted evidence) |
| `create-evals group [--model m]` | Failure modes → `.create-evals/failures.json` |
| `create-evals show <trace-id> [--full]` | A conversation with its events, end state and review |
| `create-evals drop <trace-id…>` | Delete traces that shouldn't count |
| `create-evals reset` | Archive this round's traces and failures; start fresh |
| `create-evals test [files] [--runs n] [--tier always] [--only text]` | Run `evals/*.eval.ts` |
| `create-evals list` | Every run on one screen: input, outcome, output, problems |
| `create-evals status` | Counts of traces, reviews and failure modes |

**Models.** Simulated users, the reviewer and grouping default to `claude-sonnet-5-5`. Override them with `--model`, `--user-model`, the config's `models`, or `CREATE_EVALS_{USER,REVIEW,GROUP,JUDGE}_MODEL`. OpenAI models work with `OPENAI_API_KEY`.
