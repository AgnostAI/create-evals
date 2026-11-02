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
- [ ] `defineAgent()` binding contract: `start(ctx)` → session `{ send, state? }`
- [ ] Runner process: tsx loader, module replacement hooks, network guard, shifted clock
- [ ] Per-conversation context via AsyncLocalStorage (`current()`), so fakes stay isolated under concurrency
- [ ] Simulated user (profile → messages, structured `done`)
- [ ] Trace format and transcript rendering
- [ ] Deterministic checks: empty reply, agent error, turn limit, tool error then silence
- [ ] `create-evals run`
- [ ] `create-evals review` (one note per trace: problems with quoted evidence, said vs did)
- [ ] `create-evals group` (notes → failure modes with counts and examples)
- [ ] `scenario()` and `create-evals test` (repeats, at-least-k, tiers, transcript on failure)
- [ ] `create-evals check` (binding loads, a session runs, turn 2 sees turn 1, network guarded)
- [ ] Unit tests with a fake model

### M2: Prove it on the booking agent
- [ ] Binding for the booking agent at its buggy commit (text-only history)
- [ ] `run → review → group` finds the lost-history / double-booking failure unaided
- [ ] Test written from it fails on the buggy agent, passes on the fixed one

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

(append as you go)
