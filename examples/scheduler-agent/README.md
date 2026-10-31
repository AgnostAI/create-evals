# Scheduler agent (example)

A small scheduling assistant for one person, used to develop and compare eval workflows.
Built step by step; each step adds a feature, and evals grow with it.

- **Stack:** TypeScript, Vercel AI SDK, Claude (`claude-opus-5-5`)
- **Calendar:** fake and in-memory (`src/calendar.ts`), with a fixed "now" (Mon Nov 2, 2026, 8:30 AM Pacific) so runs are repeatable

## Step 1: availability (current)

The agent answers questions about Priya's calendar with two read-only tools:

| Tool | What it does |
|---|---|
| `list_events` | events between two dates |
| `find_free_slots` | free time inside working hours (9–5 Pacific, weekdays) of at least N minutes |

## Run it

```bash
npm install
export ANTHROPIC_API_KEY=...
npm run chat    # talk to it
npm run try     # a few canned questions
```
