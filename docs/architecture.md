# Architecture

create-evals is one small npm package with two faces: a CLI (`create-evals`) that the coding agent and CI call, and a runtime (`import … from "create-evals"`) that the user's binding and tests use. Its only dependency is [`tsx`](https://tsx.is), used to load the user's TypeScript. Model calls go over `fetch`, so create-evals can't conflict with whichever AI SDK version the agent uses.

## Who does what

| | Coding agent (Claude Code, Codex…) | create-evals | Developer |
|---|---|---|---|
| Set up | Reads the code; writes `evals/agent.ts`, fakes, config | `init`, `check`; sandbox (network guard, clock, module replacement) | Test credentials, if asked |
| Profiles | Writes `.create-evals/profiles.json` from the code | Simulated users play them | |
| Run, review, group | Reads traces, drops wrong notes, writes harder rounds | `run`, `review`, `group` | |
| Confirm | Presents failure modes with quoted excerpts | | Bug, or acceptable? |
| Tests | Writes `evals/*.eval.ts`, proves each fails today | `test`: repeats, tiers, basic checks | |

The skill ([`skill/create-evals/SKILL.md`](../skill/create-evals/SKILL.md)) is the coding agent's playbook.

## A run, step by step

```
create-evals run
  │
  ├─ prepare()                         src/project.ts
  │    load .env and config.env
  │    guardNetwork(allowHosts)        src/sandbox.ts   fetch + node:http(s) patched; model APIs and localhost allowed
  │    shiftClock(now)                 src/sandbox.ts   Date and Temporal.Now start at `now` and keep ticking
  │    register tsx + loader hooks     src/hooks.ts     imports of a replaced module resolve to its fake
  │
  ├─ loadAgent()                       evals/agent.ts → defineAgent({ name, description, instructions, start })
  │
  └─ converseAll(profiles)             src/run.ts       bounded concurrency
       for each profile:
         runInContext(ctx)             src/context.ts   AsyncLocalStorage: current() inside the agent and its fakes
           session = agent.start(ctx)
           loop until done or maxTurns:
             user  = nextUserMessage() src/user.ts      a model plays the persona; returns { message, done }
             reply = session.send(user)                 the real agent; fakes call ctx.record(...)
           state = session.state()
         trace + basicChecks()         src/checks.ts    empty/repeated replies, crashes, blocked hosts
         → .create-evals/traces/<id>.json
```

`create-evals review` sends each trace to the reviewer (`src/review.ts`). The trace is rendered by `src/trace.ts`, with tool and state events interleaved between turns and the end state at the bottom. It goes along with the agent's description and instructions. The reviewer returns problems with quoted evidence, and problems whose quote isn't in the transcript are dropped. `create-evals group` sends all the problems in one call and gets back failure modes grouped by root cause. For pipelines and function agents it also sends every run plus every agent's instructions in a second call (`consistency()`), which looks for the same rule applied differently; each contradiction must be backed by two grounded quotes. Variance (the same input getting different decisions across runs) is computed without a model, from the booleans, numbers and short labels in each output.

`create-evals test` imports `evals/*.eval.ts`. Each `scenario()` call registers a test. Every test runs `converse()` `runs` times; a run fails on any basic-check finding or a throw from `check()`. A test passes when enough runs pass for its tier.

## Data

| File | Written by | Purpose |
|---|---|---|
| `evals/agent.ts` | coding agent | the binding: how to start a conversation and send a message |
| `evals/create-evals.json` | coding agent | `replace`, `allowHosts`, `env`, `now`, `concurrency`, `models` |
| `.create-evals/profiles.json` | coding agent, or `import` from real records | simulated users and inputs |
| `.create-evals/traces/*.json` | `run`, `test`, `check` | one conversation each: turns, events, end state, checks, review |
| `.create-evals/failures.json` | `group` | failure modes with counts, traces and the rule each breaks |
| `evals/evals.md` | coding agent, edited by the developer | what the agent must and mustn't do, in plain English |
| `evals/*.eval.ts` | coding agent | tests |

## Design choices

- **The binding owns history.** The runtime never rebuilds conversation history from text. The binding calls the agent the way production does, because history handling is where real bugs live.
- **Module replacement over refactoring.** Most agents call their integrations through a module the developer owns (`src/google.ts`, `src/db.ts`). Swapping that module at load time lets the unmodified agent run against a fake. The other options: a vendor test environment, or wrapping the tool.
- **Per-conversation state via `current()`.** A replaced module is a singleton, but conversations run concurrently, so fakes keep their state on `current().state`, which belongs to the conversation in progress.
- **Default deny.** During runs, only model APIs, localhost and `allowHosts` are reachable.
- **Evidence or it didn't happen.** Review problems must quote the transcript; unquoted ones are dropped.
- **Tiers, not flakiness.** Tests are `usually` until proven stable; only `always` tests fail the run (`--tier always` in CI).
- **No framework lock-in.** Tests don't depend on Vitest or Jest; checks throw (use `node:assert`). Anything callable from Node can be bound.

## Source map

```
src/
  cli.ts        commands: init, check, import, run, review, group, list, show, test, ablate, status
  project.ts    config, sandbox setup, loading the binding, reading instructions
  sandbox.ts    network guard, shifted clock
  hooks.ts      loader hooks for module replacement
  context.ts    AsyncLocalStorage conversation context: current()
  agent.ts      defineAgent, defineAgents, Session types
  run.ts        converse(): one conversation; converseAll()
  user.ts       simulated user
  review.ts     review(), group(), consistency()
  variance.ts   same input, different answers; failure-mode rates per input
  import.ts     real records (JSONL, JSON, CSV) → profiles
  ablate.ts     temp copy of the repo with one change, for `ablate`
  checks.ts     basic checks that need no model
  trace.ts      render a trace as text
  scenario.ts   scenario(), judge(), expectJudge()
  llm.ts        Anthropic/OpenAI over fetch, JSON-schema output
  spawn.ts      spawnSession(): agents in other languages over a JSON line protocol
  types.ts      Profile, Trace, Review, FailureMode
python/
  create_evals.py   the Python side of the line protocol: guard(), record(), serve()
```
