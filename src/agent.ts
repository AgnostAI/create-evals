import type { Context } from "./context.js";

/** A running conversation with the agent. The binding keeps the history, exactly as production does. */
export interface Session {
  /** Send one user message; resolve with the agent's reply as the user would see it. */
  send(message: string): Promise<string>;
  /**
   * The end state of whatever the agent changed (records, files, emails…), for reviewers and checks.
   * For a function agent you can leave it out: a JSON reply becomes the state.
   */
  state?(): unknown | Promise<unknown>;
  close?(): void | Promise<void>;
}

/** How create-evals runs your agent. Lives in `evals/agent.ts`. */
export interface AgentDefinition {
  name: string;
  /** What the agent is for and who talks to it. The simulated users and the reviewer read this. */
  description: string;
  /**
   * What the agent was told to do: repo-relative file paths (the system prompt, policy docs) or
   * literal text. The reviewer reads these to judge whether the agent did the right thing.
   */
  instructions?: string[];
  /** "function" for one-input-one-output agents; their profiles use `input` instead of a persona. Default "chat". */
  kind?: "chat" | "function";
  /**
   * For function agents: the output fields that are decisions, e.g. ["status", "relevant", "is_*"]. When a field
   * like that changes between runs of the same input, that's a flip worth reporting; other fields are ignored.
   * Without it, yes/no fields count most, then short labels and numbers; free text never does.
   */
  decisions?: string[];
  /** An input `create-evals check` sends: an opening message for a chat agent, an input for a function. */
  example?: unknown;
  /** Start one conversation. Build fresh state here (put it on `ctx.state`) and return a session. */
  start(ctx: Context): Session | Promise<Session>;
}

export function defineAgent(definition: AgentDefinition): AgentDefinition {
  return definition;
}

/**
 * Several agents in one binding, e.g. the stages of a pipeline: `export default defineAgents({ triage, research })`.
 * Each keeps its own description and instructions; profiles pick one with `"agent": "<name>"`.
 * A key names its agent when the agent has no `name`.
 */
export function defineAgents(agents: Record<string, Omit<AgentDefinition, "name"> & { name?: string }> | AgentDefinition[]): AgentDefinition[] {
  // Name the agent object itself (not a copy), so `import { triage } from "./agent.js"` in a test is the same named agent.
  const list = Array.isArray(agents) ? agents : Object.entries(agents).map(([key, a]) => Object.assign(a, { name: a.name ?? key }) as AgentDefinition);
  const names = new Set<string>();
  for (const a of list) {
    if (names.has(a.name)) throw new Error(`defineAgents: two agents are named "${a.name}".`);
    names.add(a.name);
  }
  return list;
}
