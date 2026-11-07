# create-evals

**Find your AI agent's real failures, and turn each one into a test.**

Most teams start evals by guessing what might go wrong, and the evals they write pass and catch nothing. Teams with good evals do something else: they run the agent, read what it actually did, and test what broke. create-evals makes that loop cheap enough to do on day one: before launch with realistic cases it writes from your code, and after launch by also replaying your real production inputs.

```
run your agent on realistic cases → review every run → group what went wrong
   → you confirm which are bugs → each bug becomes a test that fails today
```

It runs inside your coding agent (Claude Code, Codex, Cursor…). The coding agent reads your codebase and wires things up; create-evals does the running, reviewing and testing.

## What it finds

We gave a fresh coding agent only the skill and pointed it at agents it had never seen. Every run found real failures, each with a test that fails until it's fixed:

- **A meeting-booking agent** tells guests their real booking is fake ("the Meet link and code were made up") and books them again. It also offers times on fully booked days and then refuses them.
- **A support agent** disowns refunds it already made and refunds again (one run paid $300 on a $150 request). It also shares account details with callers it can't verify.
- **OpenAI's customer-service example** seats a lap infant in an exit row.
- **Mastra's official text-to-sql template** forgets the start of long chats, then calls its own earlier results made up.
- **LangChain's LangGraph workshop agent** crashes on every request after identity verification, and treats any all-digit ID as verified.
- **A Python sales-research pipeline** can't pass a single company through verification: the code rejects correctly cited contacts over an exact-string match. Replaying its production inputs found more: it silently drops openers one word over the limit (one company sat in 10 of 40 batches and never got one), blanks quotes from pages with non-breaking spaces, and two of its steps disagree about whether the same company is a competitor.

None of these shows up in single-message tests. The first appears on turn three, when the agent can't see what it did on turn one. [docs/validation.md](docs/validation.md) has all nine agents, how each was run, and the caveats.

## How it works

1. **Run the agent for real, safely.** Your agent's own code runs, including its tool logic and guards. What the tools touch outside the process (calendars, payments, email, databases) is pointed at a test account, or swapped for a small in-memory fake the coding agent writes. Every other network request is blocked, so evals never act for real.
2. **Realistic cases.** Written from your agent's code, not from a generic list, plus your real inputs if you have them (production traces, a database table, logs: `create-evals import`). Chats, single-call functions (classifiers, triage, research) and multi-step LLM pipelines all work, including pipelines whose steps are separate agents with their own prompts: a function gets realistic inputs aimed at its close calls; a chat gets simulated people with goals, details, and a temperament (patient, vague, pushy, changing their mind).
3. **Review.** A model reads every run, including each tool call, pipeline step and the end state, and notes where the agent went wrong. Every note must quote the transcript. It checks what the agent *said* against what it *did*.
4. **Group.** Notes become failure modes, grouped by root cause and ranked by how often they happen. Each case runs several times, so you also see **answers that flip** ("qualified in 2 of 3 runs": a coin flip, not a reproducible bug), and for pipelines, **steps that disagree** (one step treats a company as a competitor, another doesn't).
5. **About 10 cases, yes or no.** You see one line per case, with what your agent did today: "Podium: US lead, LinkedIn says United States. Should it qualify? today: no". Clear bugs come pre-answered; you only decide the judgment calls. Your answers are the evals, and each eval that guards a prompt rule is checked to fail when that rule is deleted.
6. **Done.** "10 evals created. Today 6 pass and 4 fail. Next: ask your coding agent to fix the 4 failing evals." It then offers to run the passing ones before each commit or in GitHub Actions; nothing else in your project changes unless you say yes. `npx create-evals test` reruns them anytime.

## Get started

In your agent's repo (TypeScript, Python, anything):

```bash
npx create-evals
```

Then open your coding agent there (Claude Code, Codex, Cursor) and run:

```
/create-evals
```

Then:
- It reads your agent, runs it on many realistic cases, and reads what happened. This takes 20–30 minutes for one agent, longer for a multi-step pipeline. Each command prints what create-evals' own model calls cost.
- It shows you about 10 cases, one line each, and asks: should this happen? You reply like `1y 2n 3y`.
- It writes those 10 evals and tells you how many fail today. Those are your bugs, ready for your coding agent to fix.

Afterwards, you run:

```bash
npx create-evals find    # run, review, and list what went wrong (again, after changes)
npx create-evals test    # run the tests (use --tier always in CI)
npx create-evals hook    # optional: run the evals that pass today before each commit
npx create-evals ci      # optional: same, in GitHub Actions
npx create-evals ablate --test "…" --remove "<a prompt rule>" --in prompt.ts   # does this eval fail without that rule?
```

Nothing to install, no config to write, also in Python repos. It needs Node 22+ and `ANTHROPIC_API_KEY`, used for the reviewer (and simulated users, for chats). `OPENAI_API_KEY` works too, with `--model gpt-…`.

## What ends up in your repo

```
evals/
  agent.ts          how to run your agent (the "binding"), written once; one entry per agent in a pipeline
  run_agent.py      Python repos: the agent runs as a child process
  create-evals.json what to fake, which hosts are allowed, the clock
  fake-*.ts         in-memory stand-ins for the services your tools call (if needed)
  evals.md          what your agent must and mustn't do, in plain English
  *.eval.ts         one test per confirmed case
.create-evals/      working files: cases, traces, reviews (gitignored)
```

A test for a chat reads like this:

```ts
scenario(agent, "never disowns a booking it made", {
  profile: { persona: `You're Nikhil (nikhil@orbitdesk.example). Book Friday 1pm. Afterwards ask "is it definitely booked? I don't see the invite".` },
  runs: 2,
  async check({ trace, state, said }) {
    const mine = state.bookings.filter((b) => b.guest === "nikhil@orbitdesk.example");
    assert.equal(mine.length, 1);                 // what actually happened
    assert.ok(said.includes(mine[0].code));       // what it told the guest
    await expectJudge(trace, "Never says a booking that exists is fake.");
  },
});
```

And for a function or a pipeline step:

```ts
scenario(triage, "a competitor's job post isn't a lead", {
  input: { source: "careers", company: "Cresta", text: "…AI Agent Testing 2.0…" },
  runs: 3,
  check: ({ state }) => assert.equal(state.relevant, false),
});
```

## Docs

- [Concepts](docs/concepts.md): why evals should come from failures, and the loop.
- [Architecture](docs/architecture.md): the pieces and how a run works.
- [Reference](docs/reference.md): the CLI, the config, the runtime API, and file formats.
- [The skill](skill/create-evals/SKILL.md): the step-by-step instructions coding agents follow.
- [Validation](docs/validation.md): what it found on nine agents, and what that changed.
- [Example](examples/booking-agent): a real booking agent with its binding, fakes and 15 tests.

## Status

Alpha. Works with TypeScript and JavaScript agents directly, and with Python agents (or any language) as a child process over a small line protocol; `init` scaffolds the Python side, and a Python helper ships in the package. [docs/plan.md](docs/plan.md) has what's done and what's next.

MIT licensed.
