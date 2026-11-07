import { randomUUID } from "node:crypto";
import type { AgentDefinition } from "./agent.js";
import { basicChecks } from "./checks.js";
import { runInContext, type Context } from "./context.js";
import { DEFAULT_MODELS } from "./llm.js";
import type { Profile, Trace, TraceEvent, Turn } from "./types.js";
import { nextUserMessage } from "./user.js";

export interface RunOptions {
  userModel?: string;
}

/** One conversation: the real agent against a simulated user, recording everything that happened. */
export async function converse(agent: AgentDefinition, profile: Profile, opts: RunOptions = {}): Promise<Trace> {
  const userModel = opts.userModel ?? DEFAULT_MODELS().user;
  const turns: Turn[] = [];
  const events: TraceEvent[] = [];
  let agentTurn = 0;
  const ctx: Context = {
    profile,
    state: {},
    record: (e) => events.push({ ...e, turn: agentTurn }),
  };
  const startedAt = new Date();
  const t0 = performance.now();
  let ended: Trace["ended"] = "max-turns";
  let error: string | undefined;
  let state: unknown;

  await runInContext(ctx, async () => {
    let session;
    try {
      session = await agent.start(ctx);
    } catch (e) {
      ended = "agent-error";
      error = `start() failed: ${(e as Error).stack?.split("\n").slice(0, 4).join("\n") ?? String(e)}`;
      return;
    }
    try {
      const fixed = profile.input !== undefined ? (typeof profile.input === "string" ? profile.input : JSON.stringify(profile.input, null, 2)) : undefined;
      for (let i = 0; i < (fixed !== undefined ? 1 : (profile.maxTurns ?? 10)); i++) {
        let next: { message: string; done: boolean };
        try {
          next = fixed !== undefined ? { message: fixed, done: true } : await nextUserMessage(agent, profile, turns, userModel);
        } catch (e) {
          ended = "user-error";
          error = `simulated user failed: ${(e as Error).message}`;
          break;
        }
        if (next.done && !next.message.trim()) {
          ended = "user-done";
          break;
        }
        turns.push({ role: "user", text: next.message });
        try {
          const reply = await session.send(next.message);
          turns.push({ role: "agent", text: typeof reply === "string" ? reply : String(reply ?? "") });
        } catch (e) {
          turns.push({ role: "agent", text: "" });
          ended = "agent-error";
          error = (e as Error).stack?.split("\n").slice(0, 4).join("\n") ?? String(e);
          break;
        }
        agentTurn++;
        if (next.done) {
          ended = "user-done";
          break;
        }
      }
      try {
        state = await session.state?.();
      } catch (e) {
        events.push({ turn: agentTurn, kind: "error", name: "state() failed", input: (e as Error).message });
      }
      // A function's output is its outcome: a JSON reply becomes the state, so checks and reviews can read fields.
      if (state === undefined && profile.input !== undefined) state = parseJson(turns.findLast((t) => t.role === "agent")?.text);
    } finally {
      try {
        await session.close?.();
      } catch {
        // closing is best effort
      }
    }
  });

  const trace: Trace = {
    id: `${profile.id}-${randomUUID().slice(0, 6)}`,
    agent: agent.name,
    profile,
    startedAt: startedAt.toISOString(),
    durationMs: Math.round(performance.now() - t0),
    turns,
    events,
    state,
    ended,
    error,
    checks: [],
    userModel,
  };
  trace.checks = basicChecks(trace);
  return trace;
}

/** The value of a JSON reply (a fenced ```json block works too), or undefined if it isn't JSON. */
export function parseJson(text: string | undefined): unknown {
  const t = text?.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, "$1");
  if (!t || !/^[[{]/.test(t)) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

/** Run many conversations with bounded concurrency. */
export async function converseAll(agent: AgentDefinition | ((p: Profile) => AgentDefinition), profiles: Profile[], opts: RunOptions & { concurrency?: number; onDone?: (t: Trace) => void } = {}): Promise<Trace[]> {
  const queue = [...profiles];
  const out: Trace[] = [];
  const worker = async () => {
    for (let p = queue.shift(); p; p = queue.shift()) {
      const t = await converse(typeof agent === "function" ? agent(p) : agent, p, opts);
      out.push(t);
      opts.onDone?.(t);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 4) }, worker));
  return out;
}
