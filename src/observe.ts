// Records the agent's own model calls on the conversation: what the model was told, what it wrote (including text
// the app may never show the user) and which tools it called. Passive: requests and responses are unchanged.
import { maybeCurrent, type Context } from "./context.js";

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** A model API request, by path: Anthropic Messages, OpenAI Chat Completions or Responses (or a proxy of them). */
export function isModelCall(url: string, method = "GET"): boolean {
  if (method.toUpperCase() !== "POST") return false;
  try {
    return /\/(messages|chat\/completions|responses)\/?$/.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/** Text of a message's content: a string, or the text of its blocks (tool results summarized). */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  return content
    .map((b: any) => {
      if (typeof b === "string") return b;
      if (b?.type === "text" || b?.type === "input_text" || b?.type === "output_text") return b.text ?? "";
      if (b?.type === "tool_result" || b?.type === "function_call_output") return `[tool result: ${clip(typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? b.output ?? ""), 600)}]`;
      if (b?.type === "tool_use") return `[tool call: ${b.name}]`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export interface ModelCallInput {
  /** The system prompt, when it differs from the previous call in this conversation. */
  system?: string;
  /** The newest message the model got (the user's, or tool results). */
  last?: string;
  /** Messages in the request: shows how much history the agent sends. */
  messages?: number;
  tools?: string[];
}

export interface ModelCallOutput {
  text: string;
  tools: { name: string; input: unknown }[];
  stop?: string;
}

/** What the request told the model, from an Anthropic, Chat Completions or Responses body. */
export function describeRequest(body: any): { model: string; system: string; input: Omit<ModelCallInput, "system"> } {
  const msgs: any[] = Array.isArray(body?.messages) ? body.messages : Array.isArray(body?.input) ? body.input : typeof body?.input === "string" ? [{ role: "user", content: body.input }] : [];
  const systemParts = [textOf(body?.system), body?.instructions ?? "", ...msgs.filter((m) => m?.role === "system" || m?.role === "developer").map((m) => textOf(m.content))];
  const convo = msgs.filter((m) => m?.role !== "system" && m?.role !== "developer");
  const lastMsg = convo.at(-1);
  const tools = Array.isArray(body?.tools) ? body.tools.map((t: any) => t?.name ?? t?.function?.name ?? t?.type).filter(Boolean) : undefined;
  return {
    model: String(body?.model ?? "model"),
    system: systemParts.filter(Boolean).join("\n\n"),
    input: { last: lastMsg ? clip(textOf(lastMsg.content ?? lastMsg.output ?? ""), 4000) : undefined, messages: convo.length, ...(tools?.length ? { tools } : {}) },
  };
}

const parseArgs = (s: unknown) => {
  if (typeof s !== "string") return s;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};

/** What the model wrote, from a JSON response of any of the three APIs. */
export function describeResponse(res: any, out: ModelCallOutput) {
  if (Array.isArray(res?.content)) {
    for (const b of res.content) {
      if (b?.type === "text") out.text += b.text ?? "";
      else if (b?.type === "tool_use" || b?.type === "server_tool_use") out.tools.push({ name: b.name, input: b.input });
    }
    out.stop = res.stop_reason;
  } else if (Array.isArray(res?.choices)) {
    const m = res.choices[0]?.message ?? {};
    out.text += typeof m.content === "string" ? m.content : textOf(m.content);
    for (const c of m.tool_calls ?? []) out.tools.push({ name: c.function?.name, input: parseArgs(c.function?.arguments) });
    out.stop = res.choices[0]?.finish_reason;
  } else if (Array.isArray(res?.output)) {
    for (const item of res.output) {
      if (item?.type === "message") out.text += textOf(item.content);
      else if (item?.type === "function_call") out.tools.push({ name: item.name, input: parseArgs(item.arguments) });
    }
    out.stop = res.status;
  }
}

/** What the model wrote, from a server-sent event stream of any of the three APIs. */
export function describeStream(sse: string, out: ModelCallOutput) {
  const calls: { name: string; args: string }[] = [];
  let anthropicTool: { name: string; args: string } | undefined;
  for (const line of sse.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    let e: any;
    try {
      e = JSON.parse(data);
    } catch {
      continue;
    }
    // Anthropic
    if (e.type === "content_block_start" && (e.content_block?.type === "tool_use" || e.content_block?.type === "server_tool_use")) {
      anthropicTool = { name: e.content_block.name, args: "" };
      calls.push(anthropicTool);
    } else if (e.type === "content_block_delta") {
      if (e.delta?.type === "text_delta") out.text += e.delta.text ?? "";
      else if (e.delta?.type === "input_json_delta" && anthropicTool) anthropicTool.args += e.delta.partial_json ?? "";
    } else if (e.type === "content_block_stop") anthropicTool = undefined;
    else if (e.type === "message_delta" && e.delta?.stop_reason) out.stop = e.delta.stop_reason;
    // OpenAI Responses: the final event carries the whole response.
    else if (e.type === "response.completed" && e.response) {
      out.text = "";
      out.tools = [];
      describeResponse(e.response, out);
      return;
    }
    // OpenAI Chat Completions
    else if (Array.isArray(e.choices)) {
      const d = e.choices[0]?.delta ?? {};
      if (typeof d.content === "string") out.text += d.content;
      for (const tc of d.tool_calls ?? []) {
        const i = tc.index ?? calls.length;
        calls[i] ??= { name: "", args: "" };
        if (tc.function?.name) calls[i]!.name += tc.function.name;
        if (tc.function?.arguments) calls[i]!.args += tc.function.arguments;
      }
      if (e.choices[0]?.finish_reason) out.stop = e.choices[0].finish_reason;
    }
  }
  for (const c of calls) if (c) out.tools.push({ name: c.name, input: parseArgs(c.args || "{}") });
}

const lastSystem = new WeakMap<Context, string>();
const pending = new WeakMap<Context, Promise<unknown>[]>();

/** Wait until every model call recorded on this conversation has its response read. */
export async function settle(ctx: Context): Promise<void> {
  await Promise.allSettled(pending.get(ctx) ?? []);
}

/**
 * Record one model call on the conversation in progress, if there is one. Call it before the request; it returns
 * what to call with the response (or the error), which reads a clone, so the response itself is untouched.
 */
export function observe(url: string, method: string | undefined, body: unknown): ((res: Response | Error) => void) | undefined {
  const ctx = maybeCurrent();
  if (!ctx || !isModelCall(url, method)) return undefined;
  let parsed: any;
  try {
    parsed = typeof body === "string" ? JSON.parse(body) : body instanceof Uint8Array ? JSON.parse(new TextDecoder().decode(body)) : undefined;
  } catch {
    parsed = undefined;
  }
  const req = describeRequest(parsed);
  const input: ModelCallInput = { ...req.input };
  // The system prompt is long and usually the same every call: keep it when it changes.
  if (req.system && req.system !== lastSystem.get(ctx)) {
    input.system = clip(req.system, 20_000);
    lastSystem.set(ctx, req.system);
  }
  const output: ModelCallOutput = { text: "", tools: [] };
  // Recorded now, so it lands on the turn that made it; the output fills in when the response has been read.
  ctx.record({ kind: "model", name: req.model, input, output });
  return (res) => {
    if (res instanceof Error) {
      output.stop = `failed: ${res.message}`;
      return;
    }
    // Clone before the caller reads the body; read the copy in the background.
    const copy = res.clone();
    const type = res.headers.get("content-type") ?? "";
    const done = (async () => {
      if (type.includes("text/event-stream")) describeStream(await copy.text(), output);
      else if (type.includes("json")) describeResponse(await copy.json(), output);
      if (!res.ok) output.stop = `HTTP ${res.status}`;
      output.text = clip(output.text, 8000);
    })().catch((e) => {
      output.stop = `unreadable: ${(e as Error).message}`;
    });
    pending.set(ctx, [...(pending.get(ctx) ?? []), done]);
  };
}
