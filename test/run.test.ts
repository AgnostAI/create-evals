import { afterEach, describe, expect, it } from "vitest";
import { defineAgent, current } from "../src/index.js";
import { converse } from "../src/run.js";
import { basicChecks } from "../src/checks.js";
import { render } from "../src/trace.js";
import { fakeModel } from "./helpers.js";

let restore = () => {};
afterEach(() => restore());

const echo = defineAgent({
  name: "echo",
  description: "Echoes the user and records a tool call per turn.",
  start(ctx) {
    ctx.state.count = 0;
    return {
      async send(message) {
        current().state.count++;
        current().record({ kind: "tool", name: "lookup", input: { q: message }, output: { ok: true } });
        return `you said: ${message}`;
      },
      state: () => ({ count: ctx.state.count }),
    };
  },
});

describe("converse", () => {
  it("runs the simulated user against the agent and records everything", async () => {
    const m = fakeModel([{ message: "hello", done: false }, { message: "bye", done: true }]);
    restore = m.restore;
    const t = await converse(echo, { id: "p1", persona: "says hello then bye" }, { userModel: "claude-test" });
    expect(t.turns.map((x) => x.text)).toEqual(["hello", "you said: hello", "bye", "you said: bye"]);
    expect(t.events.map((e) => [e.turn, e.name])).toEqual([[0, "lookup"], [1, "lookup"]]);
    expect(t.state).toEqual({ count: 2 });
    expect(t.ended).toBe("user-done");
    expect(t.checks).toEqual([]);
    // The simulated user sees the agent's replies as the other side of its conversation.
    expect(m.calls[1].body.messages.at(-1)).toEqual({ role: "user", content: "you said: hello" });
  });

  it("uses a fixed opening without calling the model", async () => {
    const m = fakeModel([{ message: "", done: true }]);
    restore = m.restore;
    const t = await converse(echo, { id: "p2", persona: "x", opening: "exact first line" });
    expect(t.turns[0]).toEqual({ role: "user", text: "exact first line" });
    expect(m.calls).toHaveLength(1);
  });

  it("records an agent crash as a finding instead of throwing", async () => {
    const m = fakeModel([{ message: "hi", done: false }]);
    restore = m.restore;
    const broken = defineAgent({ name: "broken", description: "", start: () => ({ send: async () => { throw new Error("boom"); } }) });
    const t = await converse(broken, { id: "p3", persona: "x" });
    expect(t.ended).toBe("agent-error");
    expect(t.checks.map((c) => c.check)).toContain("agent-error");
  });
});

describe("basic checks", () => {
  it("flag empty and repeated replies", () => {
    const t: any = { turns: [{ role: "user", text: "a" }, { role: "agent", text: "same" }, { role: "user", text: "b" }, { role: "agent", text: "same" }, { role: "user", text: "c" }, { role: "agent", text: " " }], events: [], ended: "max-turns" };
    expect(basicChecks(t).map((c) => c.check)).toEqual(["repeated-reply", "empty-reply"]);
  });
});

describe("render", () => {
  it("interleaves events with the agent turn they happened in, then the end state", () => {
    const t: any = {
      turns: [{ role: "user", text: "book it" }, { role: "agent", text: "done" }],
      events: [{ turn: 0, kind: "state", name: "created", input: { id: 1 } }],
      state: { bookings: 1 },
    };
    expect(render(t)).toBe(`USER: book it\n    [state] created {"id":1}\nAGENT (turn 0): done\n\nEND STATE:\n{"bookings":1}`);
  });
});

describe("function agents", () => {
  it("send the profile's input once, as JSON, without calling the simulated user", async () => {
    const m = fakeModel([]);
    restore = m.restore;
    const fn = defineAgent({ name: "fn", description: "", kind: "function", start: () => ({ send: async (msg) => JSON.stringify({ got: JSON.parse(msg).n * 2 }) }) });
    const t = await converse(fn, { id: "f", input: { n: 21 } });
    expect(t.turns.map((x) => x.text)).toEqual([JSON.stringify({ n: 21 }, null, 2), '{"got":42}']);
    expect(t.ended).toBe("user-done");
    expect(m.calls).toHaveLength(0);
  });
});
