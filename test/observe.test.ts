import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { describeRequest, describeResponse, describeStream, isModelCall } from "../src/observe.js";
import { render } from "../src/trace.js";

describe("recording the agent's model calls", () => {
  it("recognizes model APIs by path, also behind a proxy", () => {
    expect(isModelCall("https://api.anthropic.com/v1/messages", "POST")).toBe(true);
    expect(isModelCall("https://my-proxy.example/openai/v1/chat/completions", "POST")).toBe(true);
    expect(isModelCall("https://api.openai.com/v1/responses", "POST")).toBe(true);
    expect(isModelCall("https://api.anthropic.com/v1/messages", "GET")).toBe(false);
    expect(isModelCall("https://example.com/v1/tickets", "POST")).toBe(false);
  });

  it("reads the request: system prompt, newest message, history size, tools", () => {
    const r = describeRequest({ model: "gpt-x", messages: [{ role: "system", content: "Be kind." }, { role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }], tools: [{ type: "function", function: { name: "lookup" } }] });
    expect(r).toEqual({ model: "gpt-x", system: "Be kind.", input: { last: "c", messages: 3, tools: ["lookup"] } });
  });

  it("reads Responses API output and streams", () => {
    const out = { text: "", tools: [] as any[] };
    describeResponse({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }, { type: "function_call", name: "f", arguments: '{"a":1}' }] }, out);
    expect(out).toMatchObject({ text: "ok", tools: [{ name: "f", input: { a: 1 } }], stop: "completed" });
    const s = { text: "", tools: [] as any[] };
    describeStream(['{"type":"content_block_start","content_block":{"type":"tool_use","name":"t"}}', '{"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\\"x\\":"}}', '{"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"2}"}}', '{"type":"content_block_stop"}', '{"type":"message_delta","delta":{"stop_reason":"max_tokens"}}'].map((d) => `data: ${d}`).join("\n"), s);
    expect(s).toMatchObject({ tools: [{ name: "t", input: { x: 2 } }], stop: "max_tokens" });
  });

  it("records real fetch calls on the conversation (JSON and streamed), and not create-evals' own", () => {
    const events = JSON.parse(execFileSync(process.execPath, ["test/fixtures/observe/probe.mjs"], { encoding: "utf8" }));
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      kind: "model",
      name: "claude-x",
      input: { system: "You are Owly. Contact: a@b.example", last: "my unit smells", messages: 1, tools: ["create_ticket"] },
      output: { text: "Turn the power off first.", tools: [{ name: "create_ticket", input: { subject: "hot unit" } }], stop: "tool_use" },
    });
    // Same system prompt as before: not repeated.
    expect(events[1].input.system).toBeUndefined();
    expect(events[1]).toMatchObject({ name: "gpt-x", input: { last: "order 7?", messages: 3 }, output: { text: "Hello", tools: [{ name: "lookup", input: { id: "7" } }] } });
    const t: any = { turns: [{ role: "user", text: "hot" }, { role: "agent", text: "I created a ticket." }], events: events.map((e: any) => ({ ...e, turn: 0 })) };
    expect(render(t)).toContain(`[model] claude-x (1 messages in): wrote "Turn the power off first."; called create_ticket({"subject":"hot unit"})`);
  });
});
