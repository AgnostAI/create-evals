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
- [ ] SKILL.md drives the full loop; AGENTS.md generated from it
- [ ] A fresh subagent, given only the skill, sets up and runs the loop on the booking agent

### M4: Generalize
- [ ] Agnost `e2e-demo` (Nimo, raw OpenAI-style SDK on Claude): finds the refund dead-end unaided
- [ ] Agnost `ayurved` LLM functions (non-conversational path)
- [ ] fixtures/support-agent
- [ ] 2–3 public agents from GitHub (sandboxed: `--ignore-scripts`, network guard)
- [ ] Model comparison: reviewer on Haiku / Sonnet / Opus; simulated user on Haiku / Sonnet

### M5: Ship quality
- [ ] README, docs (concepts, architecture, binding guide, CLI + API reference)
- [ ] Example in `examples/booking-agent`
- [ ] CI workflow for this repo; `npm pack` clean; no publish without the maintainer

## Findings

- **The loop works unaided on a real bug.** On the booking agent's buggy commit (text-only history), 12 ordinary guest profiles → review → group found "loses track of its own actions" in 10/13 conversations (tells guests real bookings are fake, double-books), plus a second bug nobody had found: changing a booking creates new ones instead of moving it. A test written from it failed on the buggy agent and passed on the fixed one.
- **Group by root cause.** Grouping by symptom split one bug into 4 modes; prompting for shared causes merged them correctly.
- **Reviewer models** (same 13 traces): Sonnet and Opus both found the main bug with little noise; Haiku found it too but invented a 6-conversation mode ("offers times without looking them up") because the binding recorded the calendar's operations but not the agent's own tool calls. Default stays Sonnet; bindings must record the agent's tool calls, not just backend changes.
- **Basic checks catch real things.** On the fixed agent, the payment-link test failed on `repeated-reply`: the model's content filter fires on that request and the agent's fallback line repeats.
