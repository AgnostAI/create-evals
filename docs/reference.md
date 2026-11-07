# Reference

## CLI

Run from the agent's repo root, as `npx create-evals <command>`. Nothing needs installing: `import … from "create-evals"` in `evals/*.ts` resolves to the copy npx runs, even in a repo without a package.json. Every command that runs the agent sets up the sandbox first (see [config](#config)). Every command takes `--config <file>` to use a different config, e.g. an eval-only overlay.

| Command | Does |
|---|---|
| `create-evals` (no arguments) | Installs the skill: `.claude/skills/create-evals/SKILL.md` (Claude Code) and a section in `AGENTS.md` (Codex, Cursor, others), then says what to do next. In a terminal it lists the files and asks first (`--yes` skips the question). |
| `create-evals find` | `run`, then `review`, then `group`: from profiles to "here's what's broken". |
| `create-evals docs` | Prints this reference (bundled with the package). |
| `create-evals init [--function] [--python]` | Writes `evals/agent.ts` (a chat binding, or a one-input function binding with `--function`) and `evals/create-evals.json`, and gitignores `.create-evals/`. In a Python repo (Python project files, no `package.json`), or with `--python`, the binding starts `evals/run_agent.py` through `spawnSession`, and that runner is written too. Existing files are kept. |
| `create-evals check [--message m] [--agent a]` | Runs one short conversation (2 turns, or exactly one message with `--message`) and prints it with every event, for each agent in the binding (or the one named). Fails on agent errors, empty replies and blocked requests. Warns when no events or end state were recorded (for a function agent: when its reply isn't JSON), and when recorded tool calls have no input (usually a recorder bug the reviewer would take at face value). |
| `create-evals import <file\|-> [--input-field f] [--id-field f] [--agent a] [--kind chat\|function] [--limit n] [--out file]` | Turns real records into profiles, merged into `.create-evals/profiles.json` (an imported profile replaces one with the same id). Reads JSONL, JSON (an array, or an object holding one) and CSV (cells that look like JSON are parsed); `-` reads JSONL or JSON from stdin, for a converter script piped in. Each record becomes a function input (the whole record, or `--input-field`, a dotted path), or, if it holds a `messages`/`conversation`/`turns` list, a simulated user who replays its user messages. Profiles are named `real-<id>` from `--id-field` or the first of `id`, `key`, `domain`, `name`, `conversation_id`. Default limit 200. |
| `create-evals run [--profiles file] [--only a,b] [--repeat n] [--agent a] [--concurrency n] [--user-model m]` | Runs simulated users from `.create-evals/profiles.json` and saves each trace to `.create-evals/traces/`. Each profile runs on the agent its `agent` field names; `--agent` runs only that agent's profiles (and is the agent for profiles that name none). |
| `create-evals review [--all] [--model m] [--concurrency n]` | Reviews traces without a review, or all of them with `--all`, each against its own agent's instructions, 6 at a time (or `--concurrency`). Writes the review into each trace file. |
| `create-evals group [--model m] [--no-consistency]` | Groups all reviewed problems into failure modes and writes `.create-evals/failures.json`. With several agents, or function runs, it also compares runs and agents side by side for the same rule applied differently (one agent's output or prompt contradicting another's, or similar inputs treated differently); each such `inconsistency` needs two quotes found in the runs or instructions. The comparison runs after grouping and skips problems the modes already cover. Then it lists inputs whose decisions changed across repeated runs, and each failure mode's rate per repeated input ("2 of 3 runs of acme"). |
| `create-evals show <trace-id> [--full]` | Prints a trace: the conversation, events (clipped unless `--full`), end state, basic checks and review. A prefix of the id works. |
| `create-evals drop <trace-id…>` | Deletes traces that shouldn't count (setup mistakes, broken fakes). |
| `create-evals reset` | Moves the current traces and failures to `.create-evals/archive/<time>/`, for a fresh round. |
| `create-evals test [files…] [--runs n] [--tier always\|usually] [--only text] [--concurrency n] [--precommit] [--report file]` | Runs `evals/*.eval.ts` (or the given files). Exits 1 only when an `always` test fails; `pending` tests never count. `--precommit` = `--tier always --runs 1`, and skips (exit 0) when the model key isn't set. With `--tier always` and no `always` tests, exits 0. `--report` writes the results as JSON (`[{ name, file, tier, passed, pending?, pass, runs, skipped }]`). |
| `create-evals ablate --test text (--remove "exact text" --in file \| --patch file.diff) [--runs n] [--no-baseline] [--keep]` | Does a test have teeth? Runs the matching tests today, then on a temp copy of the repo with the change applied (`node_modules` and `.venv` are linked, not copied), and says for each whether it fails without the change. `--remove` text must appear exactly once. `--no-baseline` skips today's run; `--keep` keeps the copy. |
| `create-evals hook` | Adds a pre-commit hook running the `always` evals: appends to husky's `.husky/pre-commit` if the repo already uses husky, else the git hook; for pre-commit/lefthook configs it prints the line to add. Never installs anything or overwrites a hook. |
| `create-evals ci` | Writes `.github/workflows/evals.yml` running the `always` evals (never overwrites one). Needs the `ANTHROPIC_API_KEY` secret. |
| `create-evals list [--json]` | Every run trace on one screen: first input, last output (or review summary), end state, outcome, problems, then the inputs that got different answers across repeated runs. `--json` prints `{ runs: [{ id, agent, profile, input, output, ended, turns, checks, problems, lastReply, state, error }], variance: [{ agent, profile, runs, strong, fields: [{ field, kind, values: [[value, count]] }], reviewed?, withProblems? }] }`. A field counts when it's decision-shaped in every run: named in the agent's `decisions` (`kind: "declared"`; then nothing else counts), or, without that, a yes/no (`boolean`), a status-like identifier (`enum`: `qualified`, `not_relevant`), a short label (`label`: at most 3 words, not a URL), a `number`, or a short `list` of labels. Free text never counts. `strong` means a declared field, or a yes/no or status outside a list, flipped; those inputs are listed first, and the rest are summarized on one line. For a function run, `input` is the profile's input and `output` the parsed JSON reply. |
| `create-evals status` | Counts traces, reviews and failure modes. |

## Config

`evals/create-evals.json`. Every field is optional.

```json
{
  "agent": "evals/agent.ts",
  "now": "2026-11-02T09:00:00+05:30",
  "replace": { "src/google.ts": "evals/fake-google.ts" },
  "allowHosts": ["api.example.com", "*.supabase.co"],
  "envFile": "backend/.env",
  "env": { "OWNER_TIMEZONE": "Asia/Kolkata" },
  "concurrency": 4,
  "models": { "user": "claude-sonnet-5-5", "review": "claude-opus-5-5" }
}
```

| Field | Meaning |
|---|---|
| `agent` | The binding file. Default: `evals/agent.ts`. |
| `now` | The clock (Date and Temporal) starts here and keeps ticking. Set before the agent loads. |
| `replace` | Repo-relative module → fake. Imports that resolve to the module get the fake instead. The fake may import the real module itself (for types or helpers). |
| `allowHosts` | Hosts the agent may reach besides the model APIs (`api.anthropic.com` and `api.openai.com` are always allowed). `*.domain` matches subdomains. Add `localhost` for local sandboxes. Anything else throws and is recorded as a `network-blocked` event. |
| `envFile` | Env file(s) to load, repo-relative: a path or a list. Default: `.env`, if present. The shell wins over files, and later files over earlier ones. |
| `env` | Set before the agent loads. Wins over the shell and over `.env` (also loaded if present). `"${OTHER}"` inserts another variable, e.g. `"OPENAI_API_KEY": "${ANTHROPIC_API_KEY}"`. |
| `cwd` | Directory the agent runs in, for agents that open files relative to the working directory. |
| `concurrency` | Conversations at once for `run` and `test`. Default 4. |
| `models` | `user`, `review`, `group`, `judge`. Default `claude-sonnet-5-5` for all. The `CREATE_EVALS_{USER,REVIEW,GROUP,JUDGE}_MODEL` env vars win over this; `--model` and `--user-model` win over both. |

Commands that call models end with what create-evals' own calls cost (tokens, and dollars at Anthropic list prices). The agent's own model and tool calls aren't included.

Model ids: `claude-…` or `anthropic:…` use `ANTHROPIC_API_KEY`; `gpt-…`, `o…` or `openai:…` use `OPENAI_API_KEY`.

## Runtime API

```ts
import { defineAgent, defineAgents, current, scenario, judge, expectJudge, render } from "create-evals";
```

### `defineAgent(definition)`

```ts
interface AgentDefinition {
  name: string;
  description: string;              // what the agent does and who talks to it
  kind?: "chat" | "function";       // "function": profiles use `input`, one turn, no simulated user
  example?: unknown;                // what `check` sends (an opening message, or a function input)
  decisions?: string[];             // function agents: output fields that are decisions, e.g. ["status", "is_*", "people[].keep"]
  instructions?: string[];          // repo-relative paths (prompt, policies) or literal text, for the reviewer
  start(ctx: Context): Session | Promise<Session>;
}

interface Session {
  send(message: string): Promise<string>;     // one user message → the reply the user sees
  state?(): unknown | Promise<unknown>;       // plain data: what the agent changed (function agents: optional, a JSON reply is the state)
  close?(): void | Promise<void>;
}

interface Context {
  profile: Profile;                           // the simulated user, including profile.setup
  state: Record<string, any>;                 // per-conversation storage for fakes
  record(event: { kind: "tool" | "state" | "error" | "note"; name: string; input?: unknown; output?: unknown }): void;
}
```

### `defineAgents(agents)`

Several agents in one binding, e.g. the stages of a pipeline. Each keeps its own `description`, `instructions` and `kind`, so each trace is reviewed against its own prompt. Profiles pick one with `"agent": "<name>"`.

```ts
export const triage = defineAgent({ name: "triage", kind: "function", instructions: ["app/prompts/triage.py"], … });
export const research = defineAgent({ name: "research", kind: "function", instructions: ["app/prompts/research.py"], … });
export default defineAgents([triage, research]);   // or defineAgents({ triage, research }): keys name agents without a name
```

Tests import the agent they test: `import { triage } from "./agent.js"`.

### `current()`

Returns the `Context` of the conversation the calling code runs in. Use it in fakes and replaced modules. It throws outside a conversation.

### `scenario(agent, name, options)`

```ts
scenario(agent, "never disowns a booking it made", {
  profile: { persona: "…", setup: { … }, opening: "…", maxTurns: 6 },
  // or, for a function agent: input: { … }
  // pending: "needs triage to output a roundup field",   // expected to fail until then; never counts as a failure
  runs: 2,                 // default 1, or CREATE_EVALS_RUNS / --runs
  atLeast: 2,              // default: all runs for "always", ⌈2/3⌉ for "usually"
  tier: "usually",         // default "usually"; "always" blocks (exit 1)
  allow: ["repeated-reply"],
  async check({ trace, state, transcript, said }) { /* throw to fail */ },
});
```

`state` is the session's end state; for a function agent without `state()`, it's the parsed JSON reply. A `pending` test runs and is reported (`◌`), but doesn't count; when it starts passing, `test` says to remove `pending`.

A run fails if `check` throws or if any basic check fires (unless it's in `allow`). It's skipped, and counts neither way, if the simulated user or the judge fails (e.g. a model declines).

### `judge(trace, criterion)` and `expectJudge(trace, criterion)`

Ask a model whether the conversation meets one criterion. `judge` returns `{ pass, reasoning }`; `expectJudge` throws when the criterion isn't met. Use them only for what text alone shows, and pair them with a state check.

### `spawnSession(ctx, command, options?)`

Runs an agent in another process (Python, Go, anything) for one conversation. Use it as the session returned from `start()`:

```ts
start: (ctx) => spawnSession(ctx, [".venv/bin/python", "evals/run_agent.py"], { allowHosts: ["api.example.com"], env: { DATABASE_URL: "sqlite:///tmp/eval.db" } })
```

The child reads one `{"message", "profile"}` JSON line per user message on stdin, and answers each with a stdout line `@@CREATE_EVALS@@{"reply": "...", "events": [...], "state": ..., "error"?: "..."}`. Other output is ignored. Events are recorded on the trace, and the last `state` is the session's end state. The child gets `PYTHONPATH` with create-evals' Python helper and the repo itself (plus `src/`, if there is one), so `import yourapp` finds this checkout without `sys.path` edits. It also gets `CREATE_EVALS_ALLOW` (the allowed hosts).

**Python helper** (`create_evals.py`, shipped in the package):
- `guard(allow=())`: blocks DNS and connections except model APIs, `CREATE_EVALS_ALLOW` and `allow`. Call it before importing the app.
- `record(kind, name, input, output)`: records a tool call or state change.
- `serve(handle, state=None)`: answers lines with `handle(message, profile)`.

### `render(trace)`

The transcript as the reviewer sees it: turns, with events interleaved, and the end state.

## Files

### `.create-evals/profiles.json`

```json
{ "profiles": [ { "id": "berlin-tuesday", "persona": "You're Lena…", "setup": { "timeZone": "Europe/Berlin" }, "opening": "optional exact first message", "maxTurns": 8 } ] }
```

For `kind: "function"` agents: `{ "id": "refund-dispute", "input": { "ticket": "…", "customer": { … } } }`. The input is sent once, as JSON text, and no simulated user is called.

With several agents, each profile says which one: `{ "id": "acme", "agent": "triage", "input": { … } }`.

### Trace (`.create-evals/traces/<id>.json`)

`{ id, agent, profile, startedAt, durationMs, turns: [{role, text}], events: [{turn, kind, name, input?, output?}], state, ended, error?, checks: [{check, turn?, detail}], review?: { model, problems: [{turn, what, evidence, severity}], simulatorIssues, summary }, userModel }`

`ended` is one of `user-done`, `max-turns`, `agent-error` or `user-error`.

### `.create-evals/failures.json`

`{ reviewed, modes: [{ id, title, should, severity, traces: [ids], notes: ["trace: what"], kind? }] }`

`kind: "inconsistency"` marks a rule applied differently across agents or inputs; its notes are the contradicting quotes (`"trace-id: \"…\""` or `"agent instructions: \"…\""`).

### Basic checks

| Check | Fires when |
|---|---|
| `empty-reply` | An agent reply is empty. |
| `repeated-reply` | An agent reply repeats the previous one word for word. |
| `agent-error` | `send()` threw. |
| `network-blocked` | The agent tried to reach a host that isn't allowed. |
| `error-event` | The binding or a fake recorded an `error` event. |
