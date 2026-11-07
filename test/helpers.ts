import { vi } from "vitest";

/** Replace fetch to the model API with scripted JSON replies (one per call, in order). */
export function fakeModel(replies: unknown[]) {
  const calls: any[] = [];
  const queue = [...replies];
  const real = globalThis.fetch;
  globalThis.fetch = vi.fn(async (url: any, init: any) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), body });
    const reply = queue.shift();
    if (reply === undefined) throw new Error("fakeModel: no reply left");
    return new Response(JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(reply) }] }), { status: 200 });
  }) as typeof fetch;
  process.env.ANTHROPIC_API_KEY ??= "test";
  return { calls, restore: () => (globalThis.fetch = real) };
}
