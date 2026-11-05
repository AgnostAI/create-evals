# create-evals

**Find your AI agent's real failures, and turn each one into a test.**

Most teams start evals by guessing what might go wrong, and the evals they write pass and catch nothing. Teams with good evals do something else: they run the agent, read what it actually did, and test what broke. create-evals makes that loop cheap enough to do on day one, before you have users or production traces.

```
run your agent against simulated users → review every conversation → group what went wrong
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
- **A Python sales-research pipeline** can't pass a single company through verification: the code rejects correctly cited contacts over an exact-string match.

None of these shows up in single-message tests. The first appears on turn three, when the agent can't see what it did on turn one. [docs/validation.md](docs/validation.md) has all nine agents, how each was run, and the caveats.

## How it works

1. **Run the agent for real, safely.** Your agent's own code runs, including its tool logic and guards. What the tools touch outside the process (calendars, payments, email, databases) is pointed at a test account, or swapped for a small in-memory fake the coding agent writes. Every other network request is blocked, so evals never act for real.
2. **Simulated users.** A model plays realistic people with goals, details, and a temperament: patient, vague, pushy, changing their mind. The profiles are written from your agent's code, not from a generic list.
3. **Review.** A model reads every conversation, including each tool call and the end state, and notes where the agent went wrong. Every note must quote the transcript. It checks what the agent *said* against what it *did*.
4. **Group.** Notes become failure modes, grouped by root cause and ranked by how often they happen.
5. **You decide the judgment calls.** Clear bugs are just reported. Where the right behavior is your call, you get a plain question with a real example and two or three options.
6. **Tests.** Each bug becomes a scenario test that has to fail on today's agent before it counts. `npx create-evals test` runs them, with repeats and tiers, so flaky model behavior doesn't block your CI.

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
- It reads your agent, runs it against simulated users, and reads every conversation.
- It shows you what went wrong, with real excerpts, and asks which ones are bugs.
- It writes a test for each bug.

Afterwards, you run:

```bash
npx create-evals find    # run, review, and list what went wrong (again, after changes)
npx create-evals test    # run the tests (use --tier always in CI)
```

Nothing to install, no config to write. It needs Node 22+ and `ANTHROPIC_API_KEY`, used for the simulated users and the reviewer. `OPENAI_API_KEY` works too, with `--model gpt-…`.

## What ends up in your repo

```
evals/
  agent.ts          how to run your agent (the "binding"), written once
  create-evals.json what to fake, which hosts are allowed, the clock
  fake-*.ts         in-memory stand-ins for the services your tools call (if needed)
  evals.md          what your agent must and mustn't do, in plain English
  *.eval.ts         one test per confirmed failure mode
.create-evals/      working files: profiles, traces, reviews (gitignored)
```

A test reads like this:

```ts
scenario(agent, "never disowns a booking it made", {
  profile: { persona: `You're Nikhil (nikhil@orbitdesk.io). Book Friday 1pm. Afterwards ask "is it definitely booked? I don't see the invite".` },
  runs: 2,
  async check({ trace, state, said }) {
    const mine = state.bookings.filter((b) => b.guest === "nikhil@orbitdesk.io");
    assert.equal(mine.length, 1);                 // what actually happened
    assert.ok(said.includes(mine[0].code));       // what it told the guest
    await expectJudge(trace, "Never says a booking that exists is fake.");
  },
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

Alpha. Works with TypeScript and JavaScript agents directly, and with Python agents (or any language) as a child process over a small line protocol. A Python helper ships in the package. [docs/plan.md](docs/plan.md) has what's done and what's next.

MIT licensed.
