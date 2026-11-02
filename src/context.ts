import { AsyncLocalStorage } from "node:async_hooks";
import type { Profile, TraceEvent } from "./types.js";

/** Everything about the conversation in progress. Available anywhere in the agent's call stack via `current()`. */
export interface Context {
  profile: Profile;
  /** Record a tool call, state change or error so the reviewer and checks can see it. */
  record(event: Omit<TraceEvent, "turn">): void;
  /** Per-conversation storage for fakes, e.g. `ctx.state.calendar = new FakeCalendar(seed)`. */
  state: Record<string, any>;
}

const storage = new AsyncLocalStorage<Context>();

export function runInContext<T>(ctx: Context, fn: () => Promise<T>): Promise<T> {
  return storage.run(ctx, fn);
}

/**
 * The conversation this code is running in. Use it in replaced modules and fakes, so each
 * conversation gets its own state even when several run at once.
 */
export function current(): Context {
  const ctx = storage.getStore();
  if (!ctx) throw new Error("create-evals: current() was called outside a conversation.");
  return ctx;
}

/** Like `current()`, but undefined outside a conversation. */
export function maybeCurrent(): Context | undefined {
  return storage.getStore();
}
