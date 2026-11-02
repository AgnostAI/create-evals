# Contributing

Thanks for helping. Start with [AGENTS.md](AGENTS.md): it has the commands, the rules, and pointers to the design docs. It's written for coding agents, and it works for humans too.

- **Bugs and ideas:** open an issue. If create-evals got something wrong on your agent, include the trace (`.create-evals/traces/<id>.json`, with anything private removed) and what you expected.
- **Pull requests:** keep them focused. Include tests: `npm test` runs offline with a fake model. If you changed prompts (simulated user, reviewer, grouping), describe how you checked the change on a real agent.
- **New framework examples** are very welcome: a small agent in `examples/` with its binding and a few tests.
