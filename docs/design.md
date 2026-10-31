# create-evals: design

create-evals gives an AI agent evals as strong as τ²-bench's or Gemini CLI's, written for *that* agent, inside its own repo. It runs inside a coding agent (Claude Code, Codex). The coding agent does the understanding; create-evals provides the runtime, the checks, and the proof that the evals catch bugs.

This doc merges five research tracks (`.context/design/01–05`). It's grounded in a hand-built reference suite (`examples/booking-agent/evals/`), which found real bugs, and in its first mutation score.

## What "good" means

An eval is good if it catches a bug the agent could ship. The old create-evals restated prompt lines as one-message tests against tools that always returned `{ ok: true }`; 10 of 11 passed on the first run. The reference suite, built the τ²/Gemini way, found two real bugs in an agent we thought worked:

1. **Lost tool history.** The agent kept only text between turns, and the AI SDK's `response.messages` holds only the last step. It then told guests their real bookings were fake and booked them again.
2. **Silence.** When the model stopped mid-turn (a content filter), the guest got silence, even right after a successful booking, so they never got their code. The history also kept a tool call with no result, which broke every later turn.

None of these shows up in a single turn, in a stateless fake, or in a check on reply wording. All three need many turns, real tool code against a stateful world, and checks on what actually happened.

## The five parts

### 1. World: a stateful fake of what the agent touches, with its real code running

The agent's **real tools and guards run**. Only what the developer doesn't own gets faked, just below the code they do own. Per external system, the host agent climbs this ladder:

| Rung | When | How |
|---|---|---|
| 0 | No side-effecting tools | No world |
| 1 | An existing seam (factory arg, URL env, `cwd`) | Use it |
| 2 | Filesystem, git, SQLite or Postgres | A real local sandbox: temp dir or repo, seeded SQLite, PGlite |
| 3 | The developer's own integration module (`./google.ts`, `./db.ts`) | Swap it in the test runner: `vi.mock("./google.js")` → the world |
| 4 | Vendor HTTP scattered through tools | A stateful MSW fake of the vendor API |
| 5 | MCP or remote tools | Patch `execute`, and label those guards untested |

- **No refactoring needed.** Verified: the *pre-refactor* booking agent (hard-imports Google, reads `Temporal.Now`) booked into the in-memory world with zero source changes, via `vi.mock` plus a frozen clock. `vi.setSystemTime` also freezes `Temporal.Now` in Node 26. 9 real repos were read and none needs a refactor (`.context/design/02-world.md`).
- **Always on:**
  - a network jail (only model providers allowed);
  - a temporary `HOME` (one real repo deletes `~/.credentials` on a 401);
  - a scrubbed env;
  - a frozen clock set before the agent is imported (three repos capture "today" at import).
- **LLMs never play the backend at run time.** They can't keep state consistent, and end-state checks become meaningless.

### 2. Scenarios: derived from this agent's structure, proven to have teeth

No domain categories or risk lists. The host agent asks 13 **structural questions** that every tool-using agent has answers to. The answers come only from this agent's code, with file:line evidence:

- What does a user claim that tools can check?
- Who may cause each state change, and how does the agent know who's asking?
- Where is each rule enforced: code, prompt, or nowhere?
- What edges do the config numbers have, in the *user's* frame?
- What can change between reading and acting?
- What must survive across turns?
- What happens right around each commit?
- What can tools return besides success?
- Where does untrusted text land?
- What do users want that rules forbid, and what's the fallback?
- What's adjacent but shouldn't be done?
- Can the data settle ambiguity?
- Where does the agent report what it did?

A strong scenario has a *tension*: a claim against a record, policy against desire, a commit against a change. It also has a persona with goals, tactics and a fallback; a seeded world with a bystander or victim; and checks on end state. Every scenario must pass the **swap test**: if it would make sense for another agent, it's rejected. A scenario is kept only if it has **teeth**: it fails on the current agent, kills a planted bug, or its pass rate drops when its rule is deleted.

Trials on two real repos found likely real bugs by reading alone. A notes tool can't reach the folder the prompt names, so the agent says "saved" when nothing was saved. A terminal agent's prompt claims every shell command needs approval, but by default most don't. (`.context/design/03-scenarios.md`)

### 3. Simulated user

The simulated user is a cheaper model playing a persona with known info, unknown info, tactics and a fallback, as τ² does. Measured problems in ours:
- it didn't know today's date, and booked the wrong Monday;
- it leaked tool syntax in 1 of 11 runs;
- it answered its own questions in 6 of 11 runs;
- when it stopped talking decided which bugs showed.

Fixes:
- give it the date;
- fixed scripted lines where the scenario depends on them;
- scripted follow-ups after the user is done ("did it go through?", "what's my code?") to surface retractions;
- an automatic simulator audit on every failing run, so a simulator mistake is never reported as an agent bug.

### 4. Graders: outcome first, generic where possible

Per scenario:
- **End-state checks** in TypeScript, against the world: one booking, the same code moved, no cancellation email.

Generic, running on every scenario with no per-scenario code:
- **Said vs. did.** An LLM pulls out the agent's claims, and a second pass checks each against the tool calls, results, world log and final state. A non-LLM rule catches claimed actions with no call, and actions never reported. On the bug transcripts it flagged 44 false claims (Opus agreed on 151 of 152 sampled verdicts). On 19 clean transcripts it raised 0 false positives. Its catch: in 5 replays of the lost-history bug the scenario's own checks passed every time, while said-vs-did failed the 3 runs where the agent lied. Haiku 5.5 matched Sonnet on 26 of 26 at about 1/20 the cost.
- **Checks that don't use a model:**
  - no empty replies;
  - no silence after a tool error;
  - created ids and links reach the user.

  These caught the content-filter silence with 0 false positives on 25 traces.
- **LLM judges** only for what only text shows, always paired with a state check. Since models no longer accept a temperature, reliability comes from repeats and caching.

### 5. Proof: mutation testing and reliability tiers

`create-evals mutate` plants realistic bugs in a temp copy of the agent and runs the scenarios that touch the mutated code. The host agent chooses mutants from the code: delete a guard, delete a prompt rule, break history handling, label times in the wrong zone. The score is the share caught.

The first measurement, on the hand-built suite, shows why this has to be careful:
- **Raw score: 6 of 11.**
- **Two were false catches** by a scenario that's flaky on the clean agent (the content-filter bug).
- **Two mutants changed nothing:** the prompt still stated the rule the code had lost, so behavior was identical.
- **The intermittent lost-history bug was missed** in one run.
- **Honest score: about 4 of 9.**

So:
- a catch counts only if the scenario was stable on the clean agent and fails again on a re-run;
- mutants that change nothing are filtered out;
- failure reasons are saved;
- missed mutants become the brief for the next scenarios.

Tiers, as Gemini CLI does them:
- New scenarios start as `USUALLY_PASSES` (at least ⌈2k/3⌉ of k runs).
- They're promoted to `ALWAYS_PASSES` after a clean history; only that tier gates PRs.
- `KNOWN_FAILING` holds open findings.

A 21-for-21 streak only bounds the failure rate at about 13%. Twenty ALWAYS scenarios × 3 runs go red about 70% of the time by chance. So PR runs retry a failure once and audit the simulator before calling it red; nightly runs do 3× per scenario and drive promotion. (`.context/design/04-graders.md`)

## The product

**Three artifacts:**
- `create-evals`: the CLI plus the skill.
- `@create-evals/runtime`: a small dev dependency providing:
  - `scenario()`, `converse()`, adapters;
  - `World` base, clock, jail;
  - the simulated user;
  - said-vs-did and the no-model checks;
  - repeats and tiers, and reporting.

  It calls model APIs over `fetch`, so it can't conflict with the user's AI SDK version (v0.1's copied-in judge broke on AI SDK v4/v6). `eject` vendors it for teams that want no dependency.
- **Generated code in the user's repo**, owned by the developer: `evals/evals.md`, `world.ts`, `agent.ts` (the adapter binding), `*.eval.ts`, `mutants.ts`.

**`evals/evals.md` is the source of truth for *what*.** Rules are headings, and each bullet is `situation → expected behavior` with a stable id. Each `scenario("id")` takes its name from its bullet. A bullet with no scenario is a todo; a scenario with no bullet fails. "Add a bullet and ask your coding agent to sync" is how evals get added later. Scenarios are TypeScript, because seeds, mid-conversation events and checks are code anyway.

**Adapters keep the framework's own history.** The runtime never rebuilds history from text; that's the bug we found. Built in: Vercel AI SDK, OpenAI Agents SDK, Mastra, LangGraph.js, raw Anthropic and OpenAI, single-call functions, and a custom fallback. The first smoke test the skill runs is "does turn 2 still see turn 1's tool calls?"

**Commands:**
- `skill` (install)
- `scan` (facts, hints, mutation sites)
- `check` (evals.md ↔ scenarios, citations, swap test)
- `mutate`

Running evals is plain `vitest` (`npm run evals`; `EVALS_RUNS`, `EVALS_TIER`). CI doesn't need our CLI.

**The skill flow inside Claude Code:**
1. Map the agent.
2. Build the world and binding, then smoke-test history.
3. Ask the 13 questions, then draft scenarios and evals.md.
4. Run each 3× and sort the outcomes:
   - findings: report them, don't ask;
   - flaky: tier them;
   - free passes: keep them as regression locks, labeled.
5. Ask the developer only about gaps, showing the real transcript and 2–3 options.
6. Run `mutate`, and write a scenario for each missed bug.
7. Report, leading with findings.

## Where create-evals competes

Commoditized:
- simulated users (LangWatch Scenario, DeepEval, promptfoo);
- LLM judges;
- "a skill that writes evals into your repo" (LangWatch, DeepEval, promptfoo, and Anthropic's `/claude-api build-eval`, Sep 28).

Unowned:
- **a world built from the agent's own integration code,** with real guards running;
- **end-state and said-vs-did grading;**
- **mutation-proven suites** that mutate the agent's code, not just the prompt, and run multi-turn;
- **pass^k and tiers in TypeScript.**

We don't depend on LangWatch Scenario: no world, no end-state checks, no pass^k, heavy dependencies, a global tracer, `ai@^6`. (`.context/design/01-landscape.md`)

## How we'll know it works

**Benchmark: 10 runnable agents**
- the booking agent
- the 4 fixtures
- ports of sim repos (their prompts and tool schemas, our handlers, none of their code runs)
- a τ² airline slice
- a raw-SDK agent

**Measurement:**
- Each agent gets about 10 planted bugs the generator never sees.
- Main metric: the mutation score of the generated suite, at a fixed false-alarm rate.
- Also measured: blind human ratings of scenario sharpness, number of developer questions, and cost.
- Baselines: v0.1, promptfoo, LangWatch Scenario, the hand-written suites, and v1 with each part removed in turn.

**Target:** generated suites catch at least 80% of what the hand-written suite catches.

## Build order (riskiest first)

0. **Baseline** the hand-built booking suite properly: k=3, filtered mutants, saved reasons, cost per run.
1. **Runtime core:** `scenario()`, `converse()` with the AI SDK adapter, `World` base, clock and jail, the simulated user with the fixes, said-vs-did, the no-model checks, tiers.
2. **Port the booking suite onto the runtime.** It must reproduce the same catches.
3. **Skill v1** (world ladder, 13 questions, teeth, gaps-only questions) plus `check`. Run it fresh on the booking agent with *no access to the hand-written suite*, and compare mutation scores. This is the test that decides whether the project works.
4. `mutate` with the scoring rules above.
5. Generalize: run the skill on the sim repos (ported) and fixtures; add the OpenAI Agents and Mastra adapters.
6. Benchmark harness and baselines; then docs and publish.

## Open decisions

- **The 13 structural questions are fixed;** their answers are not. This is how "no hard-coded categories" is met: no domains or risk lists, only questions every tool-using agent can answer from its own code. Confirm this meets the bar.
- **Runtime dependency vs. copy-in by default.** The proposal is a dependency, plus `eject`.
- **Cost.** A 13-scenario run is about 13 conversations of 4–8 Opus turns plus a cheap simulator and graders. Mutation runs multiply that, so they run at setup and weekly, not per PR.
