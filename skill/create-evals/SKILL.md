---
name: create-evals
description: Find an AI agent's real failures and turn each one into a test. Runs the agent in this repo against simulated users (with its tools pointed at fakes or sandboxes), reviews every conversation for mistakes, groups them into failure modes, asks the developer which are bugs, and writes a test for each. Use when the user asks for evals, agent tests, "what does my agent get wrong", red-teaming, or regression tests for an LLM agent.
---

# create-evals

You're going to find out what this repo's agent actually gets wrong, and turn each confirmed problem into a test that fails today and protects the fix forever.

Good evals come from failures, not from brainstorming. So you don't guess what might go wrong. You run the agent, read what it did, and test what broke. `npx create-evals` gives you the tools: it runs conversations, reviews them, groups the problems, and runs tests. You do the parts that need understanding this codebase.

The loop:

```
1 set up → 2 profiles → 3 run → 4 review → 5 group → 6 developer confirms → 7 tests → 8 report
              ▲                             │
              └─── nothing found: harder ───┘
```

Work in the repo root. create-evals reads `evals/create-evals.json` and `evals/agent.ts`, and keeps its working files in `.create-evals/` (gitignored).

## 1. Set up: run the agent like production, safely

```bash
npx create-evals init
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

Never change the agent's source to make it testable without asking the developer. If a bug blocks everything after it (a crash on every turn), you can apply the one-line fix in an eval-only overlay config (`npx create-evals run --config evals/overlay.json`, with `replace` pointing at a patched copy) to explore further, and report the fix as finding #1.

**The config** (`evals/create-evals.json`):
- `replace`: modules to swap for fakes.
- `allowHosts`: hosts the agent may reach. Model APIs are always allowed; **everything else is blocked**, localhost included (add `"localhost"` for a local sandbox), and a blocked call fails loudly in the trace.
- `env`: variables set before the agent loads. `"${OTHER}"` references another variable, e.g. `"OPENAI_API_KEY": "${ANTHROPIC_API_KEY}"` with `"OPENAI_BASE_URL": "https://api.anthropic.com/v1/"` runs an OpenAI-SDK agent on Claude.
- `now`: an ISO time the clock starts at. Use it when the agent's behavior depends on dates.
- `concurrency`: set to 1 if conversations would share state.

**Agents that aren't chats** (classifiers, triage, extractors, pipelines: one input → one output) use the same loop. Run `npx create-evals init --function`, and set `kind: "function"` plus an `example` input in the binding. Profiles are `{ "id": "...", "input": { ...any JSON... } }`, with no persona. `send()` receives the input as JSON text, calls the function, records anything in between (model calls, which model answered), and returns the output as text for the reviewer. Write the inputs yourself: realistic, varied, and aimed at where the function must make a judgment. `npx create-evals list` shows all inputs and outputs side by side, which is where rates and outliers show up.

**Agents in another language** (Python, Go…): the binding is still TypeScript, and the agent runs as a child process, one per conversation:

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
npx create-evals check
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

## 3–5. Run, review, group

```bash
npx create-evals run         # every profile once; --repeat 2 to see variance; --only id,id
npx create-evals review      # a model reads each new trace and notes what went wrong, quoting evidence
npx create-evals group       # merges the notes into failure modes: .create-evals/failures.json
```

Then do what the tools can't: **read**. Open at least the traces behind each failure mode with `npx create-evals show <trace-id>`, plus a few marked ok.
- Drop notes that are wrong: the reviewer misread something, or the simulated user caused it.
- Look for what the reviewer can't see: failures caused by the instructions themselves (the agent obeys and the user still hits a dead end), and patterns that only show across many conversations.
- Fix your fakes if *they* misbehaved, and re-run.
- If the reviewer missed something you can see, note it yourself.

Traces from setup mistakes or broken fakes shouldn't count: remove them with `npx create-evals drop <trace-id…>`. Start a clean round with `npx create-evals reset` (it archives the old one). When you regroup, new failure modes are marked `[new]`.

**If you found little, the profiles were too easy.** Write a harder round aimed at what earlier runs never touched (tools never called, rules never tested, longer conversations, users who push back). Run, review and group again. Two or three rounds is normal. Stop when a new round finds nothing new.

## 6. The developer decides

For each failure mode, show the developer:
- the title;
- how often it happened (e.g. 10 of 13 conversations);
- a short quoted excerpt from one transcript that shows it (the user's line, what the agent did, what actually happened);
- the rule it seems to break.

Ask: **bug, or acceptable?** Use your host's multiple-choice tool if it has one. Never decide for them. "Bug" becomes a test; "acceptable" goes in evals.md as intended behavior.

Write `evals/evals.md`, the human-readable record of what this agent should do:

```markdown
# Evals: booking-agent

What the agent must and mustn't do. Every rule has tests in evals/*.eval.ts: `npx create-evals test`.

## Never tells a guest that a real booking is fake
Found in 10 of 13 simulated conversations. Tests: booking-flow.eval.ts
- Asks "is it definitely booked?" after booking → keeps the one real booking and gives its code

## Accepted behavior
- States Shubham's working hours in his own time zone (decided by Shubham, 2026-11-02)
```

## 7. Tests

For each confirmed bug, write a test in `evals/<rule>.eval.ts`:

```ts
import assert from "node:assert/strict";
import { expectJudge, scenario } from "create-evals";
import agent from "./agent.js";

scenario(agent, "never disowns a booking it made", {
  profile: { persona: "…the failing trace's persona, sharpened to steer into the failure…", maxTurns: 6 },
  runs: 2,
  async check({ trace, state, said }) {
    const mine = state.bookings.filter((b: any) => b.guest === "nikhil@orbitdesk.io");
    assert.equal(mine.length, 1, `expected one booking, found ${mine.length}`);       // end state first
    assert.ok(said.includes(mine[0].code), "never gave the guest the real code");     // then what it said
    await expectJudge(trace, "The agent never says a booking that exists is fake."); // judge last, only for what text alone shows
  },
});
```

- Start from the failing trace's profile, and sharpen it so it reliably walks into the situation.
- Check the end state and actions first, the agent's words second, and use `expectJudge` only for what only the text can show.
- Every test also fails on empty replies, agent errors and blocked network calls, without you writing anything. Use `allow: ["repeated-reply"]` to tolerate a specific check.
- **A test must fail on today's agent before it counts.** Run `npx create-evals test --only "<name>"`. If it passes, sharpen the persona or the check until it reproduces the failure. A test that can't reproduce the bug proves nothing.
- Use `runs: 2` or 3. New tests are tier `"usually"` (reported, not blocking). Promote a test to `tier: "always"` (blocks CI) once it has passed reliably after the fix.
- **Guard tests.** Rules that only the prompt enforces can hold today and break with the next prompt or model change. For the important ones, write a test even though it passes now. Then prove it has teeth: in a scratch copy of the repo, delete that rule from the prompt and run the test. It should fail. If it still passes, the test doesn't guard the rule; sharpen it.

Add `"evals": "create-evals test"` to package.json scripts.

## 8. Report

Tell the developer:
- **What's broken**, most important first: each confirmed failure mode, how often, one quoted example, and the test that catches it (which fails right now).
- **What's set up:** the binding, which systems are faked and which are real (anything wrapped at step 4 is untested code), and `evals/evals.md`.
- **How to run:** `npm run evals`. It makes real model calls, so it costs money and needs the agent's API key. Runs on every PR should use `--tier always`.
- **Next:** fix the bugs (offer to help). When a test passes reliably, promote it to `always`. Re-run the loop after big changes to the prompt or tools, or on real production conversations when there are some.

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
