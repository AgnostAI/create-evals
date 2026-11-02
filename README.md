# create-evals

**Find your AI agent's real failures, and turn each one into a test.**

Most teams start evals by guessing what might go wrong, and the evals they write pass and catch nothing. Teams with good evals do something else: they run the agent, read what it actually did, and test what broke. create-evals makes that loop cheap enough to do on day one, before you have users or production traces.

```
run your agent against simulated users → review every conversation → group what went wrong
   → you confirm which are bugs → each bug becomes a test that fails today
```

It runs inside your coding agent (Claude Code, Codex, Cursor…). The coding agent reads your codebase and wires things up; create-evals does the running, reviewing and testing.

## What it finds

On an example meeting-booking agent that looked fine in manual testing, twelve ordinary simulated guests turned up:

> **Loses track of its own actions** (10 of 13 conversations). It tells guests their real booking is fake ("the Meet link and code were made up, no invite was sent") and books them again. One guest ended up with three real meetings while being told they had none.
>
> **Moves a booking by creating a new one** (1 of 13). The original stays on the calendar, and the guest gets three invites.

Neither shows up in a single-message test. The first only appears on turn three, when the agent can't see what it did on turn one. Both are now tests that failed before the fix and pass after it.

## How it works

1. **Run the agent for real, safely.** Your agent's own code runs, including its tool logic and guards. What the tools touch outside the process (calendars, payments, email, databases) is pointed at a test account, or swapped for a small in-memory fake the coding agent writes. Every other network request is blocked, so evals never act for real.
2. **Simulated users.** A model plays realistic people with goals, details, and a temperament: patient, vague, pushy, changing their mind. The profiles are written from your agent's code, not from a generic list.
3. **Review.** A model reads every conversation, including each tool call and the end state, and notes where the agent went wrong. Every note must quote the transcript. It checks what the agent *said* against what it *did*.
4. **Group.** Notes become failure modes, grouped by root cause and ranked by how often they happen.
5. **You decide.** For each failure mode: bug, or acceptable? That's the only question you're asked.
6. **Tests.** Each bug becomes a scenario test that has to fail on today's agent before it counts. `npx create-evals test` runs them, with repeats and tiers, so flaky model behavior doesn't block your CI.

## Get started

In your agent's repo, ask your coding agent:

> Set up create-evals for the agent in this repo (`npx create-evals`, see its skill), find what it gets wrong, and write tests.

Install the skill so it knows how:

```bash
npm i -D create-evals
mkdir -p .claude/skills && cp -r node_modules/create-evals/skill/create-evals .claude/skills/   # Claude Code
cat node_modules/create-evals/skill/AGENTS.md >> AGENTS.md                                  # Codex, Cursor, others
```

Or drive it yourself:

```bash
npx create-evals init      # evals/agent.ts (how to run your agent) + evals/create-evals.json
npx create-evals check     # one short conversation to prove the setup works
# write .create-evals/profiles.json (who talks to your agent)
npx create-evals run
npx create-evals review
npx create-evals group     # → .create-evals/failures.json
npx create-evals test      # runs evals/*.eval.ts
```

It needs Node 22+ and `ANTHROPIC_API_KEY`, used for the simulated users and the reviewer (or `OPENAI_API_KEY` with `--model gpt-…`).

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
- [Example](examples/booking-agent): a real booking agent with its binding, fakes and 15 tests.

## Status

Alpha. Works with TypeScript and JavaScript agents. The binding is plain code, so any agent you can call from Node should work; Python agents driven through a subprocess are untested. [docs/plan.md](docs/plan.md) has what's done and what's next.

MIT licensed.
