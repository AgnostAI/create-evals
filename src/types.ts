/** A simulated user to run the agent against. */
export interface Profile {
  id: string;
  /** Which agent to run, when the binding defines several (`defineAgents`). */
  agent?: string;
  /** Who the user is, what they want, how they behave, and what they know. Written for this agent. */
  persona?: string;
  /**
   * For agents that aren't chats: the exact input (any JSON value). The conversation is one turn:
   * `send()` receives it as JSON text (or as-is, if it's a string), and no simulated user is called.
   */
  input?: unknown;
  /** Agent-specific setup handed to `start()`, e.g. which world seed to load or the user's time zone. */
  setup?: Record<string, unknown>;
  /** Exact first message, if the scenario depends on it. */
  opening?: string;
  /** Default 10. */
  maxTurns?: number;
}

/** Something that happened during a conversation besides talking: a tool call, a state change, an error. */
export interface TraceEvent {
  /** Index of the agent turn it happened in. */
  turn: number;
  /** "model": one of the agent's own model calls, recorded automatically (what it was told, what it wrote). */
  kind: "tool" | "state" | "error" | "note" | "model";
  name: string;
  input?: unknown;
  output?: unknown;
}

export interface Turn {
  role: "user" | "agent";
  text: string;
}

/** A finding from a check that doesn't call a model (empty reply, crash, repeated reply). */
export interface CheckFinding {
  check: string;
  turn?: number;
  detail: string;
}

export interface Problem {
  /** Agent turn where it first shows. */
  turn: number;
  what: string;
  /** Quoted from the transcript. Problems whose evidence isn't in the transcript are dropped. */
  evidence: string;
  severity: "high" | "medium" | "low";
}

export interface Review {
  model: string;
  problems: Problem[];
  /** The simulated user misbehaved (broke character, answered for the agent…): not the agent's fault. */
  simulatorIssues: string[];
  summary: string;
}

export interface Trace {
  id: string;
  agent: string;
  profile: Profile;
  startedAt: string;
  durationMs: number;
  turns: Turn[];
  events: TraceEvent[];
  /** What the session reported as its end state, if it can. */
  state?: unknown;
  ended: "user-done" | "max-turns" | "agent-error" | "user-error";
  error?: string;
  checks: CheckFinding[];
  review?: Review;
  userModel: string;
  /** Set by `create-evals test`: which test this run belonged to and why it failed. */
  test?: { name: string; passed: boolean; reason?: string };
}

export interface FailureMode {
  id: string;
  /** What goes wrong, concretely. */
  title: string;
  /** The rule it breaks, as the developer would state it: "Never tells a guest a booking is fake when it exists." */
  should: string;
  severity: "high" | "medium" | "low";
  traces: string[];
  /** One representative note per trace: "trace-id: what". */
  notes: string[];
  /** "inconsistency": the same rule applied differently across agents or inputs. Its notes are the contradicting quotes. */
  kind?: "failure" | "inconsistency";
}
