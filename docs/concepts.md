# Concepts

## Evals come from failures

Teams that ship agents with good evals mostly don't write evals by imagining risks. They read what their agent actually did, find where it went wrong, and turn those failures into tests. Brainstormed evals tend to restate the prompt ("the prompt says confirm before booking, so test that it confirms"), and the agent passes them because it was told the rule. Evals built from real failures test what actually breaks, and they come with proof: a test that failed before the fix.

So the core of create-evals isn't generating tests. It's making error analysis cheap:

```
run → review → group → confirm → test → fix
 ▲                │
 └── too easy ────┘
```

1. **Run.** Get real runs. With production traffic, replay its inputs (`create-evals import`): they cover what's common. Before launch you have none, so you manufacture them: the real agent against realistic inputs and simulated users. Either way, add cases aimed at the rules and the rare edges, because real traffic rarely covers them. Run each case several times: an answer that flips is a finding in itself.
2. **Review.** Read every conversation and note the first thing that went wrong, with evidence. Free text, not categories.
3. **Group.** Notes collapse into a handful of failure modes, grouped by root cause and counted. They emerge from *this* agent's behavior, so nobody has to write a category list. Some failures only show when runs are compared: the same input answered differently, or two steps of a pipeline applying one rule two ways.
4. **Confirm.** Clear bugs (the agent contradicts its own records, crashes, blocks its own job) are just reported. Where the right behavior is a product decision, a person who knows what "right" looks like picks it, from plain-language options. That's the only judgment a human has to make.
5. **Test.** Each bug becomes a test that reproduces it. If it doesn't fail on today's agent, it isn't a test yet.
6. **Fix,** and keep the test forever as a regression lock.

When a round finds nothing, the inputs were too easy, not the agent too good. Write harder profiles aimed at what hasn't been exercised, and go again.

## Run the agent for real, fake only what's dangerous

An agent is a model, a prompt, tool code, and whatever the tools touch. The first three are safe to run for real, and the tool code is where many bugs live (permission checks, limits, state handling), so it must run. Only the last part, the outside world, needs care. Per external system, take the first option that works:

1. Harmless: leave it real.
2. The vendor has a test version (Stripe test mode, a staging database, a temp folder): use it.
3. Swap the developer's own integration module for a small in-memory fake with the same exports.
4. Last resort: fake the tool itself. Its code then goes untested.

Everything else is blocked at the network level, so a missed integration fails loudly instead of emailing a customer.

**Call the agent exactly as production does.** The binding has to keep conversation history the way production keeps it. The booking example's worst bug lived precisely there: production kept only text between turns, so the agent couldn't see its own earlier tool calls. A test harness that kept full history would never have found it.

## Simulated users are people, not prompts

A profile is a person with a goal, the details they know (names, ids that exist in the fake's data), and a temperament: patient, vague, pushy, changes their mind, asks "did it go through?". Most profiles should be ordinary users doing ordinary jobs over several turns. Many real failures surface in exactly those conversations, not in attacks.

Profiles are written from the agent's code, by asking structural questions about *this* agent:
- What do users claim that the tools could check?
- Who may cause each change, and how does the agent know who it's talking to?
- What must survive across turns?
- What happens right before and after it commits an action?
- What can tools return besides success?
- Where does untrusted text end up?
- What do users want that the rules forbid?

The answers differ for every agent. There's no list of risk categories.

## Judge outcomes, then words

The strongest check is what actually happened: what's in the database, what was sent, what was booked. Next comes whether the agent told the truth about it ("said vs did"). An LLM judge comes last, only for what only text can show, and is paired with a state check wherever possible. The reviewer must quote the transcript for every problem; notes whose quote isn't in the transcript are dropped.

## Flakiness is a fact; tier it

Models are nondeterministic. A test that passes once can fail one time in five. Tests run several times and need a pass count:
- New tests start as **usually** passes. They're reported, but they don't block.
- After they've passed reliably (every run, and the case never flipped), they're promoted to **always**, which blocks CI. A test that guards a prompt rule must also fail when the rule is deleted (`create-evals ablate`); otherwise it protects nothing.

This is how Gemini CLI's behavioral evals work, and it keeps CI trustworthy.
