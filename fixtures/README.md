# Fixtures

Small agents with problems planted on purpose, used as targets when validating create-evals. Give a fresh coding agent only the skill, point it at a copy of one, and see what the loop finds. Withhold `expected.json` (the planted problems) and `REFERENCE_FIX.md` until it has written its report. See [docs/validation.md](../docs/validation.md) for results.

| Fixture | Shape |
|---|---|
| `support-agent` | Vercel AI SDK chat agent: orders, refunds, subscriptions, email |
| `coding-agent` | Tool-using coding assistant: files and shell |
| `ops-agent` | Operations agent with deploy and infrastructure tools |
| `triage-agent` | One input → structured output (a support-ticket triage function) |
