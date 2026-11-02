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

This writes `evals/agent.ts` (the binding) and `evals/create-evals.json` (the config). Read the agent's code first: find the entry point production uses (the route handler, CLI, or worker), how it keeps conversation history, every tool, and what each tool touches outside the process.

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

Never change the agent's source to make it testable without asking the developer.

**The config** (`evals/create-evals.json`):
- `replace`: modules to swap for fakes.
- `allowHosts`: hosts the agent may reach. Model APIs are always allowed; **everything else is blocked**, localhost included (add `"localhost"` for a local sandbox), and a blocked call fails loudly in the trace.
- `env`: variables set before the agent loads. `"${OTHER}"` references another variable, e.g. `"OPENAI_API_KEY": "${ANTHROPIC_API_KEY}"` with `"OPENAI_BASE_URL": "https://api.anthropic.com/v1/"` runs an OpenAI-SDK agent on Claude.
- `now`: an ISO time the clock starts at. Use it when the agent's behavior depends on dates.
- `concurrency`: set to 1 if conversations would share state.

**Agents that aren't chats** (classifiers, triage, extractors, pipelines: one input → one output) use the same loop. Each profile's `opening` is the input (e.g. a JSON payload) with `maxTurns: 1`. `send()` parses it, calls the function, records any intermediate calls, and returns the output as text (e.g. pretty JSON) for the reviewer to judge against the instructions. Write the inputs yourself: realistic, varied, and aimed at where the function must make a judgment.

**Agents in another language** (Python, Go…): the binding is still TypeScript. `start()` spawns the agent as a subprocess (or calls it over a local HTTP endpoint the binding starts, with `"localhost"` in `allowHosts`), and `send()` passes the message through. The network guard only covers the Node process, so point the child at fakes or test credentials through its environment, and say in the report what isn't guarded.

Then:

```bash
npx create-evals check
```

This runs one short conversation and prints it, with every recorded event. Fix what it reports. Before moving on, confirm three things by reading the output:
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
- Optionally add a passing test for important behavior the agent gets right, so it stays right.

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
| `create-evals init` | Scaffold `evals/agent.ts` and `evals/create-evals.json` |
| `create-evals check` | One short conversation; verifies the setup |
| `create-evals run [--profiles f] [--only a,b] [--repeat n]` | Conversations → `.create-evals/traces/` |
| `create-evals review [--all] [--model m]` | Notes per trace (problems with quoted evidence) |
| `create-evals group [--model m]` | Failure modes → `.create-evals/failures.json` |
| `create-evals show <trace-id>` | A conversation with its events, end state and review |
| `create-evals test [files] [--runs n] [--tier always] [--only text]` | Run `evals/*.eval.ts` |
| `create-evals status` | Counts of traces, reviews and failure modes |

**Models.** Simulated users, the reviewer and grouping default to `claude-sonnet-5-5`. Override them with `--model`, `--user-model`, the config's `models`, or `CREATE_EVALS_{USER,REVIEW,GROUP,JUDGE}_MODEL`. OpenAI models work with `OPENAI_API_KEY`.
