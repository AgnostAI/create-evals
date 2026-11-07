import type { Context } from "./context.js";

/** A running conversation with the agent. The binding keeps the history, exactly as production does. */
export interface Session {
  /** Send one user message; resolve with the agent's reply as the user would see it. */
  send(message: string): Promise<string>;
  /** The end state of whatever the agent changed (records, files, emails…), for reviewers and checks. */
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
  /** An input `create-evals check` sends: an opening message for a chat agent, an input for a function. */
  example?: unknown;
  /** Start one conversation. Build fresh state here (put it on `ctx.state`) and return a session. */
  start(ctx: Context): Session | Promise<Session>;
}

export function defineAgent(definition: AgentDefinition): AgentDefinition {
  return definition;
}
