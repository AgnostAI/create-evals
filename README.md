# create-evals

**Find your AI agent's real failures, and turn each one into a test.**

Guessed evals pass and catch nothing. create-evals runs your agent on realistic cases, reads what it actually did, and turns what broke into tests that fail today.

```bash
npx create-evals     # in your agent's repo: TypeScript, Python, anything
```

Then, in Claude Code, Codex or Cursor:

```
/create-evals
```

About 20–30 minutes later you have around 10 evals, and the failing ones are your bugs.

## What it catches

A fresh coding agent with only the skill, on agents it had never seen:

- A **booking agent** tells guests their real booking is fake, then books them again.
- A **support agent** forgets a refund it already made and refunds again ($300 paid out on a $150 request).
- **OpenAI's customer-service example** seats a lap infant in an exit row.
- **LangChain's LangGraph workshop agent** crashes on every request after identity verification.

Single-message tests miss all of these. The booking bug only shows up on turn three. [All nine agents →](docs/validation.md)

## How it works

```
run your agent on realistic cases → review every run → group what went wrong
   → you confirm which are bugs → each bug becomes a test that fails today
```

- **Runs your real code, safely.** Tools that reach the outside world (calendars, payments, email) are pointed at a test account or an in-memory fake. All other network requests are blocked.
- **Cases come from your code**, or from production inputs replayed with `create-evals import`. Chats get simulated users with goals and moods. Functions and pipelines get inputs aimed at their close calls.
- **Every review note quotes the transcript.** The reviewer checks what the agent *said* against what it *did*. It also flags answers that flip between runs and pipeline steps that disagree.
- **You answer yes or no.** You get one line per case, like `Podium: US lead. Should it qualify? today: no`, and reply `1y 2n 3y`. Each answer becomes a test.

## The tests

Plain TypeScript, checked into `evals/`:

```ts
scenario(agent, "never disowns a booking it made", {
  profile: { persona: `You're Nikhil (nikhil@orbitdesk.example). Book Friday 1pm, then ask "is it definitely booked?"` },
  runs: 2,
  async check({ state, said, trace }) {
    const mine = state.bookings.filter((b) => b.guest === "nikhil@orbitdesk.example");
    assert.equal(mine.length, 1);              // what it did
    assert.ok(said.includes(mine[0].code));    // what it said
    await expectJudge(trace, "Never says a booking that exists is fake.");
  },
});
```

```bash
npx create-evals test    # run them (--tier always in CI)
npx create-evals find    # look for new failures after a change
npx create-evals hook    # optional: run before each commit (or `ci` for GitHub Actions)
```

Needs Node 22+ and `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY` with `--model gpt-…`). There's nothing to install and no config to write.

## Docs

[Concepts](docs/concepts.md) · [Architecture](docs/architecture.md) · [Reference](docs/reference.md) · [The skill](skill/create-evals/SKILL.md) · [Validation](docs/validation.md) · [Example agent](examples/booking-agent)

Alpha. TypeScript/JavaScript agents run in-process. Python and other languages run as a child process. [Roadmap](docs/plan.md). MIT licensed.
