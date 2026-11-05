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
- [x] Agnost `e2e-demo` (Nimo, raw OpenAI-style SDK on Claude): finds the refund dead-end unaided (the coding agent did; the reviewer missed it until it learned that instructions can be the bug)
- [x] Non-conversational path (fixtures/triage-agent; opening = input, maxTurns 1)
- [x] A Python agent (Agnost enterprise-outbound research agents, subprocess binding)
- [x] fixtures/support-agent
- [x] 2–3 public agents from GitHub (sandboxed: `--ignore-scripts`, network guard)
- [x] Model comparison: reviewer on Haiku / Sonnet / Opus (agent on Haiku vs Sonnet in the Nimo run)

### M5: Ship quality
- [x] README, docs (concepts, architecture, binding guide, CLI + API reference)
- [x] Example in `examples/booking-agent`
- [x] CI workflow for this repo; `npm pack` clean; no publish without the maintainer

### Next
- [x] LangGraph.js agent (langgraph-101-ts: six real failures)
- [ ] Production-trace import into `review`, for teams that already log conversations
- [ ] `create-evals mutate`: plant bugs (delete a prompt rule, break a guard) and score whether the tests catch them; the guard-test check in the skill is the manual version today
- [x] Published create-evals@0.1.0 to npm (2026-11-05)

## Findings

- **The loop works unaided on a real bug.** On the booking agent's buggy commit (text-only history), 12 ordinary guest profiles → review → group found "loses track of its own actions" in 10/13 conversations (tells guests real bookings are fake, double-books), plus a second bug nobody had found: changing a booking creates new ones instead of moving it. A test written from it failed on the buggy agent and passed on the fixed one.
- **Group by root cause.** Grouping by symptom split one bug into 4 modes; prompting for shared causes merged them correctly.
- **Reviewer models** (same 13 traces): Sonnet and Opus both found the main bug with little noise; Haiku found it too but invented a 6-conversation mode ("offers times without looking them up") because the binding recorded the calendar's operations but not the agent's own tool calls. Default stays Sonnet; bindings must record the agent's tool calls, not just backend changes.
- **Basic checks catch real things.** On the fixed agent, the payment-link test failed on `repeated-reply`: the model's content filter fires on that request and the agent's fallback line repeats.
- **Fresh agents, given only the skill, found real bugs on three agents** (each ran ~25–40 conversations, about 25 minutes):
  - *Booking agent (buggy commit):* the lost-history bug (8/15 conversations), plus a bug nobody had found: `find_open_times` ignores the per-day cap that booking enforces, so it offers times on full days and then refuses them. The reviewer missed that one; the coding agent found it by reading traces.
  - *Support-agent fixture:* the same lost-history class (the agent disowns real refunds and redoes them; one run paid $300 on a $150 request), PII shared with unverified callers, and refund splitting to dodge approval. 6 of 7 tests fail on today's agent.
  - *Nimo (Agnost e2e-demo):* the known refund dead end (10/10 billing conversations), and replies cut off by a 300-token cap (empty on Sonnet).
- **Lost tool history is common.** Two of three real agents returned only text from their chat function, so the model can't see what it did on earlier turns.
- **The reviewer needs a human-like reader on top.** Its high-severity notes were accurate. About half its low ones were wrong or trivial, and it missed failures the instructions themselves cause. The skill now makes the coding agent read traces, and the reviewer prompt asks for precision and treats instructions as a possible bug.
- **Simulated-user refusals happen** on impostor personas. Fixed with authorized-testing framing and server-side fallback, and runs where the simulator fails are skipped rather than failed.
- **An independent code review found 14 issues; all fixed with regression tests (18 unit tests).** The worst: an `always` test passed when every run was skipped (e.g. no API key in CI); the evidence filter dropped real quotes from escaped JSON tool output; the network guard could be bypassed (http options host, raw net/tls, WebSocket), so it now enforces at `net.Socket#connect`; `Date()` without `new` and `instanceof Date` broke under the clock shift; two copies of the package split the conversation context and the test registry (now shared via `globalThis`).
