// Model calls over plain fetch, so create-evals never conflicts with the AI SDK version an agent uses.
// Models: "claude-…" or "anthropic:…" (ANTHROPIC_API_KEY), "gpt-…", "o…" or "openai:…" (OPENAI_API_KEY).

export interface Message {
  role: "user" | "assistant";
  content: string;
}

export interface JsonRequest {
  model: string;
  system: string;
  messages: Message[];
  /** JSON Schema for the reply. Objects need `additionalProperties: false` and every key in `required`. */
  schema: Record<string, unknown>;
  maxTokens?: number;
  /** Anthropic effort: lower is faster and cheaper. Defaults to the model's own default. */
  effort?: "low" | "medium" | "high";
}

export interface Model {
  json<T>(req: JsonRequest): Promise<T>;
}

export class ModelError extends Error {}

/** Read at call time, so .env, config `env` and config `models` (applied by prepare()) take effect. */
export const DEFAULT_MODELS = () => ({
  user: process.env.CREATE_EVALS_USER_MODEL || "claude-sonnet-5-5",
  review: process.env.CREATE_EVALS_REVIEW_MODEL || "claude-sonnet-5-5",
  group: process.env.CREATE_EVALS_GROUP_MODEL || "claude-sonnet-5-5",
  judge: process.env.CREATE_EVALS_JUDGE_MODEL || "claude-sonnet-5-5",
});

/** Tokens create-evals itself spent this process, per model. Your agent's own model calls aren't in here. */
export const usage: Record<string, { calls: number; input: number; output: number; cacheRead: number; cacheWrite: number }> = {};

function addUsage(model: string, u: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }) {
  const row = (usage[model] ??= { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  row.calls++;
  row.input += u.input ?? 0;
  row.output += u.output ?? 0;
  row.cacheRead += u.cacheRead ?? 0;
  row.cacheWrite += u.cacheWrite ?? 0;
}

// USD per million input / output tokens, Anthropic first-party rates. Unknown models get no dollar figure.
const PRICES: [RegExp, number, number][] = [
  [/fable|mythos/, 10, 50],
  [/opus-5-5/, 4, 20],
  [/opus/, 5, 25],
  [/sonnet-4/, 3, 15],
  [/sonnet/, 2, 10],
  [/haiku-5/, 0.1, 0.5],
  [/haiku/, 1, 5],
];

/** Estimated dollars for create-evals' own calls so far, or undefined if a model's price is unknown. */
export function cost(): number | undefined {
  let total = 0;
  for (const [m, u] of Object.entries(usage)) {
    const price = PRICES.find(([re]) => re.test(m));
    if (!price) return undefined;
    // Cache writes cost 1.25x input, reads 0.1x.
    total += ((u.input + u.cacheWrite * 1.25 + u.cacheRead * 0.1) * price[1] + u.output * price[2]) / 1e6;
  }
  return total;
}

/** One line for the end of a command: "create-evals model calls: 41 calls, 312k tokens, about $0.84". */
export function usageLine(): string | undefined {
  const rows = Object.values(usage);
  if (!rows.length) return undefined;
  const calls = rows.reduce((n, u) => n + u.calls, 0);
  const tokens = rows.reduce((n, u) => n + u.input + u.output + u.cacheRead + u.cacheWrite, 0);
  const usd = cost();
  const k = tokens >= 1e6 ? `${(tokens / 1e6).toFixed(1)}M` : `${Math.round(tokens / 1000)}k`;
  return `create-evals model calls: ${calls}, ${k} tokens${usd !== undefined ? `, about $${usd < 0.1 ? usd.toFixed(3) : usd.toFixed(2)}` : ""} (your agent's own calls not included)`;
}

/** The env var holding the key a model needs. */
export function keyFor(modelId: string): string {
  return provider(modelId).name === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
}

/** Hosts create-evals itself talks to; the network guard always allows them. */
export const MODEL_HOSTS = ["api.anthropic.com", "api.openai.com"];

function provider(model: string): { name: "anthropic" | "openai"; id: string } {
  const [prefix, rest] = model.includes(":") ? model.split(/:(.*)/s) : ["", model];
  if (prefix === "openai" || (!prefix && /^(gpt-|o\d|chatgpt-)/.test(model))) return { name: "openai", id: rest! };
  return { name: "anthropic", id: prefix === "anthropic" ? rest! : model };
}

async function post(url: string, headers: Record<string, string>, body: unknown): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(300_000) });
    } catch (e) {
      // Network errors and timeouts: retry, then report as a model failure (tests skip rather than fail).
      if (attempt >= 4) throw new ModelError(`${url}: ${(e as Error).message}`);
      await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
      continue;
    }
    if (res.ok) {
      try {
        return await res.json();
      } catch (e) {
        throw new ModelError(`${url} returned a malformed body: ${(e as Error).message}`);
      }
    }
    const text = await res.text();
    const retryable = res.status === 429 || res.status === 529 || res.status >= 500;
    if (!retryable || attempt >= 4) throw new ModelError(`${url} → ${res.status}: ${text.slice(0, 400)}`);
    const wait = Number(res.headers.get("retry-after")) * 1000 || 2000 * 2 ** attempt;
    await new Promise((r) => setTimeout(r, Math.min(wait, 30_000)));
  }
}

function key(name: string): string {
  const value = process.env[name];
  if (!value) throw new ModelError(`${name} is not set.`);
  return value;
}

export const model: Model = {
  async json<T>(req: JsonRequest): Promise<T> {
    const p = provider(req.model);
    if (p.name === "openai") {
      const res = await post(
        "https://api.openai.com/v1/chat/completions",
        { authorization: `Bearer ${key("OPENAI_API_KEY")}` },
        {
          model: p.id,
          messages: [{ role: "system", content: req.system }, ...req.messages],
          response_format: { type: "json_schema", json_schema: { name: "reply", schema: req.schema, strict: true } },
        },
      );
      addUsage(req.model, { input: res.usage?.prompt_tokens, output: res.usage?.completion_tokens });
      const choice = res.choices?.[0];
      if (choice?.message?.refusal) throw new ModelError(`${req.model} refused: ${choice.message.refusal}`);
      if (!choice?.message?.content) throw new ModelError(`${req.model} returned no content (finish_reason ${choice?.finish_reason}).`);
      try {
        return JSON.parse(choice.message.content) as T;
      } catch {
        throw new ModelError(`${req.model} returned non-JSON: ${choice.message.content.slice(0, 200)}`);
      }
    }
    // Server-side fallback: if the model declines (playing an adversarial user, reviewing a hostile
    // transcript), the API retries on a fallback model inside the same call. Not available on Haiku.
    const fallback = !/haiku/.test(p.id);
    const res = await post(
      "https://api.anthropic.com/v1/messages",
      {
        "x-api-key": key("ANTHROPIC_API_KEY"),
        "anthropic-version": "2023-06-01",
        ...(fallback ? { "anthropic-beta": "server-side-fallback-2026-07-01" } : {}),
      },
      {
        model: p.id,
        max_tokens: req.maxTokens ?? 16_000,
        system: req.system,
        messages: req.messages,
        output_config: { format: { type: "json_schema", schema: req.schema }, ...(req.effort ? { effort: req.effort } : {}) },
        ...(fallback ? { fallbacks: "default" } : {}),
      },
    );
    // With a server-side fallback, the turn may have run on another model: count it under the one that answered.
    addUsage(res.model ?? req.model, { input: res.usage?.input_tokens, output: res.usage?.output_tokens, cacheRead: res.usage?.cache_read_input_tokens, cacheWrite: res.usage?.cache_creation_input_tokens });
    if (res.stop_reason === "refusal") throw new ModelError(`${req.model} declined this request.`);
    const text = (res.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ModelError(`${req.model} returned non-JSON (stop_reason ${res.stop_reason}): ${text.slice(0, 200)}`);
    }
  },
};
