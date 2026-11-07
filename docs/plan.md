# Build plan

The plan for create-evals v1. Agents and contributors: check off items as they land, and add what you learn under **Findings**.

## The loop being built

```
set up (once) → profiles → run → review → group → developer confirms → tests → fix → CI
                   ▲                                │
                   └──── nothing found: harder ─────┘
```

See [architecture.md](architecture.md) for the components and [concepts.md](concepts.md) for the reasoning.

## Milestones

### M1: Runtime and CLI core
- [x] `defineAgent()` binding contract: `start(ctx)` → session `{ send, state? }`
- [x] Runner process: tsx loader, module replacement hooks, network guard, shifted clock
- [x] Per-conversation context via AsyncLocalStorage (`current()`), so fakes stay isolated under concurrency
- [x] Simulated user (profile → messages, structured `done`)
- [x] Trace format and transcript rendering
- [x] Deterministic checks: empty reply, agent error, turn limit, tool error then silence
- [x] `create-evals run`
- [x] `create-evals review` (one note per trace: problems with quoted evidence, said vs did)
- [x] `create-evals group` (notes → failure modes with counts and examples)
- [x] `scenario()` and `create-evals test` (repeats, at-least-k, tiers, transcript on failure)
- [x] `create-evals check` (binding loads, a session runs, turn 2 sees turn 1, network guarded)
- [x] Unit tests with a fake model

### M2: Prove it on the booking agent
- [x] Binding for the booking agent at its buggy commit (text-only history)
- [x] `run → review → group` finds the lost-history / double-booking failure unaided
- [x] Test written from it fails on the buggy agent, passes on the fixed one

### M3: The skill
- [x] SKILL.md drives the full loop; AGENTS.md generated from it
- [x] A fresh subagent, given only the skill, sets up and runs the loop on the booking agent

### M4: Generalize
- [x] An internal support demo bot (raw OpenAI-style SDK on Claude): finds the refund dead-end unaided (the coding agent did; the reviewer missed it until it learned that instructions can be the bug)
- [x] Non-conversational path (fixtures/triage-agent; opening = input, maxTurns 1)
- [x] A Python agent (an internal company-research pipeline, subprocess binding)
- [x] fixtures/support-agent
- [x] 2–3 public agents from GitHub (sandboxed: `--ignore-scripts`, network guard)
- [x] Model comparison: reviewer on Haiku / Sonnet / Opus (agent on Haiku vs Sonnet in the support-bot run)

### M5: Ship quality
- [x] README, docs (concepts, architecture, binding guide, CLI + API reference)
- [x] Example in `examples/booking-agent`
- [x] CI workflow for this repo; `npm pack` clean; no publish without the maintainer

### Next
- [x] LangGraph.js agent (langgraph-101-ts: six real failures)
- [x] Real-data import: `create-evals import` turns JSONL/JSON/CSV records (a trace export, a DB table, logs) into profiles; logged conversations become replayed users
- [ ] Direct trace pull (e.g. `import --from agnost`, by agent and time range) instead of an exported file
- [x] `create-evals ablate`: run a test on a temp copy with one change (a rule removed, a patch) and say whether it has teeth
- [ ] `create-evals mutate`: plant many bugs automatically and score the suite; `ablate` is the one-change version
- [x] Pipelines and function agents first-class: `defineAgents`, per-agent instructions in review, JSON reply = state, `scenario({ input })`, `pending` tests
- [x] Variance as a headline: "same input, different answers" in `list` and `group`, failure-mode rate per repeated input
- [x] Consistency pass in `group`: the same rule applied differently across agents or similar inputs
- [x] Cost of create-evals' own model calls after each command (the agent's own calls aren't visible)
- [ ] Pytest wrapper for Python repos (evals in Python, the TS engine underneath)
- [x] Round 2 on the pipeline: variance by decision fields (`decisions`), `import -` for converters, Python `init`, `review --concurrency`, bugs pre-answered in the y/n list
- [x] Published create-evals@0.1.0 to npm (2026-11-05)

## Findings

- **The loop works unaided on a real bug.** On the booking agent's buggy commit (text-only history), 12 ordinary guest profiles → review → group found "loses track of its own actions" in 10/13 conversations (tells guests real bookings are fake, double-books), plus a second bug nobody had found: changing a booking creates new ones instead of moving it. A test written from it failed on the buggy agent and passed on the fixed one.
- **Group by root cause.** Grouping by symptom split one bug into 4 modes; prompting for shared causes merged them correctly.
- **Reviewer models** (same 13 traces): Sonnet and Opus both found the main bug with little noise; Haiku found it too but invented a 6-conversation mode ("offers times without looking them up") because the binding recorded the calendar's operations but not the agent's own tool calls. Default stays Sonnet; bindings must record the agent's tool calls, not just backend changes.
- **Basic checks catch real things.** On the fixed agent, the payment-link test failed on `repeated-reply`: the model's content filter fires on that request and the agent's fallback line repeats.
- **Fresh agents, given only the skill, found real bugs on three agents** (each ran ~25–40 conversations, about 25 minutes):
  - *Booking agent (buggy commit):* the lost-history bug (8/15 conversations), plus a bug nobody had found: `find_open_times` ignores the per-day cap that booking enforces, so it offers times on full days and then refuses them. The reviewer missed that one; the coding agent found it by reading traces.
  - *Support-agent fixture:* the same lost-history class (the agent disowns real refunds and redoes them; one run paid $300 on a $150 request), PII shared with unverified callers, and refund splitting to dodge approval. 6 of 7 tests fail on today's agent.
  - *Internal support demo bot:* the known refund dead end (10/10 billing conversations), and replies cut off by a 300-token cap (empty on Sonnet).
- **Lost tool history is common.** Two of three real agents returned only text from their chat function, so the model can't see what it did on earlier turns.
- **The reviewer needs a human-like reader on top.** Its high-severity notes were accurate. About half its low ones were wrong or trivial, and it missed failures the instructions themselves cause. The skill now makes the coding agent read traces, and the reviewer prompt asks for precision and treats instructions as a possible bug.
- **Simulated-user refusals happen** on impostor personas. Fixed with authorized-testing framing and server-side fallback, and runs where the simulator fails are skipped rather than failed.
- **An internal outbound pipeline (Python, several function agents in a pipeline), run by a fresh agent with 0.1.3:** the loop worked, but treating a pipeline like a chat agent cost the most. It wrote a dispatcher binding (so the reviewer judged one step against every step's prompt, and tests needed `as any`), returned each result twice (reply and `state()`), and got "no end state" warnings on pure functions. Its best findings weren't in any single trace: two steps disagreed on whether the same company is an agent vendor, and one step rejected a competitor-like company that another qualified. Flips mattered more than any single answer (one company qualified in 2 of 3 runs). It hand-wrote 35 inputs although real ones were in a database table and in production traces, and did the "remove the rule, see the test fail" check by hand with rsync and a symlinked venv. All of these are now built in; the pytest wrapper and a direct trace pull are not.
- **The same pipeline, run 2 (fresh agent, dev build):** 92 inputs imported from production traces plus 29 hand-written, ×3 runs. Real inputs found six problems run 1 hadn't, including two that silently lose output in production: outputs over the code's word limit are dropped (one company appeared in 10 of 40 production batches and never got one), and quotes from pages with non-breaking spaces are blanked by an exact-match check. The reviewer saw neither (it can't see U+00A0, and the production effect only shows by comparing outputs across batches); the agent found them in `list --json`. The imported inputs missed every hand-written edge from run 1 (competitors, a cross-step contradiction), so imports must add to targeted cases, not replace them. Variance first flagged 68 inputs, but only 4–5 were real decision flips. The rest were free-text fields, plus a bug that reported present values as "(missing)". Now only decision-shaped fields count (7 inputs on the same traces), and a binding can name them. A recorder bug in the binding (server-side searches logged without queries) became a false high-severity mode; `check` now warns about tool events with no input. Traces that store the rendered prompt rather than the structured input need a converter (`import -`).
- **The same pipeline, run 2b (0.1.6, through to the done message):** 17 evals (9 failing bugs, 7 guards, 1 pending). Review with `--concurrency 12` took 24 s for 54 runs, where it had taken about 10 minutes. `ablate` showed teeth on one rule and none on two. Opus obeyed those two rules without being told, or another rule covered them. The consistency check caught a cross-step rule clash, but quoted only the prompts (no runs) and missed a second clash that a failure mode already covered from one side. It now asks for runs from each side, and doesn't treat a one-agent mode as covering a cross-agent disagreement. Mode rates counted review notes, not behavior. They now read "flagged in 2 of 3 runs", and say so when the agent's decisions were the same in every run. The skill promoted an eval that later flipped to `always`; it now asks for 3 passing runs and no flips first.
- **Zero install was broken on Node 22 in repos without a package.json** (Python repos): the binding compiles as CommonJS, and Node 22's `registerHooks` doesn't cover `require()`, so `require("create-evals")` and `require("./agent.js")` both failed. Node 23+ hid it locally; CI on Node 22 caught it. Now the package ships `dist/index.cjs` and wraps `Module._resolveFilename`.
- **A fresh agent on an unseen open-source agent (a Next.js support bot, 0.1.7), checked by an independent judge (6.5/10):** 13 evals, 6 of them real bugs the judge confirmed in code, 4 of those deterministic (oldest-50-messages history, a keyword heuristic marking answered chats escalated, the contact never reaching the prompt, substring team matching). What went wrong:
  - Loading needed a hand-written workaround: tsx's CommonJS loader wasn't registered, so tsconfig `paths` and extensionless imports failed in a repo without `"type": "module"`.
  - One eval had the wrong cause. The app drops text the model writes alongside tool calls, and traces didn't show model output, so it looked like a model judgment call.
  - About 20% of reviewer notes were false, mostly from judging against source files instead of the runtime-built prompt.
  - Intermittent bugs passed under `usually`'s 2-of-3 threshold, and `ablate` verdicts flipped at 2 runs.
  - It missed the dangerous tool surfaces: anyone's history, any email recipient, and a tool error crashing the chat.

  Fixed in 0.1.8. Both tsx loaders are registered, and `replace` also applies to `require()`. The agent's model calls are recorded from `fetch`, streams included, and the reviewer gets the prompt the model received. Every run must pass by default. `ablate` runs 3 times and reports rates. Grouping makes fewer modes, with outcome rules. The skill asks what a user can reach that isn't theirs.
- **An independent code review found 14 issues; all fixed with regression tests (18 unit tests).** The worst: an `always` test passed when every run was skipped (e.g. no API key in CI); the evidence filter dropped real quotes from escaped JSON tool output; the network guard could be bypassed (http options host, raw net/tls, WebSocket), so it now enforces at `net.Socket#connect`; `Date()` without `new` and `instanceof Date` broke under the clock shift; two copies of the package split the conversation context and the test registry (now shared via `globalThis`).
