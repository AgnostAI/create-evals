# Working on create-evals

Guidance for coding agents (and humans) changing this repo. To *use* create-evals on an agent, follow [skill/create-evals/SKILL.md](skill/create-evals/SKILL.md) instead.

## What this is

create-evals finds an AI agent's real failures and turns them into tests. It runs the agent against simulated users, reviews each conversation, groups the problems, and runs scenario tests. Read [docs/concepts.md](docs/concepts.md), then [docs/architecture.md](docs/architecture.md); the source map is at the end of the architecture doc. [docs/plan.md](docs/plan.md) is the live plan: check off what you finish and add what you learn under Findings.

## Commands

```bash
export PATH="$HOME/.local/node/bin:$PATH"   # if node isn't on PATH
npm install
npm run build          # tsup bundle + tsc declarations → dist/ (needed before `npm test`: one test runs the built loader)
npm test               # unit tests, fake model, no API key needed
npm run typecheck
node dist/cli.js --help
```

Try it on the example agent (needs `ANTHROPIC_API_KEY`; makes real model calls):

```bash
cd examples/booking-agent && npm install
node ../../dist/cli.js check
node ../../dist/cli.js test --only "walks away"
```

## Rules

- **Keep it light.** The runtime has one dependency (`tsx`). Model calls go over `fetch` (`src/llm.ts`). Don't add a dependency for something a few lines can do.
- **No hard-coded risk categories.** Profiles, reviews and failure modes come from the agent's own code and behavior. Prompts may ask structural questions; they must not ship domain checklists.
- **Evidence or it didn't happen.** Reviewer output must quote the transcript; keep the grounding filter in `review()`.
- **Run the agent like production.** Never rebuild conversation history in the runtime; the binding owns it.
- **Test with a fake model.** `test/helpers.ts` → `fakeModel([...replies])`. Anything that touches loader hooks or the sandbox needs a child process (see `test/replace.test.ts`).
- **The skill is the product too.** When you change a command or behavior, update `skill/create-evals/SKILL.md`, `docs/reference.md`, then `npm run sync:agents` (regenerates `skill/AGENTS.md`).
- **Validate changes on real agents.** The best check is a fresh agent following the skill on an agent it hasn't seen. See Findings in docs/plan.md for what that has caught before.
- Claude API rules for `src/llm.ts`: no `temperature`; structured output via `output_config.format`; handle `stop_reason: "refusal"`.
