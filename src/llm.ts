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
}

export interface Model {
  json<T>(req: JsonRequest): Promise<T>;
}

export class ModelError extends Error {}

export const DEFAULT_MODELS = {
  user: process.env.CREATE_EVALS_USER_MODEL ?? "claude-sonnet-5-5",
  review: process.env.CREATE_EVALS_REVIEW_MODEL ?? "claude-sonnet-5-5",
  group: process.env.CREATE_EVALS_GROUP_MODEL ?? "claude-sonnet-5-5",
  judge: process.env.CREATE_EVALS_JUDGE_MODEL ?? "claude-sonnet-5-5",
};

/** Hosts create-evals itself talks to; the network guard always allows them. */
export const MODEL_HOSTS = ["api.anthropic.com", "api.openai.com"];

function provider(model: string): { name: "anthropic" | "openai"; id: string } {
  const [prefix, rest] = model.includes(":") ? model.split(/:(.*)/s) : ["", model];
  if (prefix === "openai" || (!prefix && /^(gpt-|o\d|chatgpt-)/.test(model))) return { name: "openai", id: rest! };
  return { name: "anthropic", id: prefix === "anthropic" ? rest! : model };
}

async function post(url: string, headers: Record<string, string>, body: unknown): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    if (res.ok) return res.json();
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
      const choice = res.choices?.[0];
      if (choice?.message?.refusal) throw new ModelError(`${req.model} refused: ${choice.message.refusal}`);
      return JSON.parse(choice?.message?.content ?? "null") as T;
    }
    const res = await post(
      "https://api.anthropic.com/v1/messages",
      { "x-api-key": key("ANTHROPIC_API_KEY"), "anthropic-version": "2023-06-01" },
      {
        model: p.id,
        max_tokens: req.maxTokens ?? 16_000,
        system: req.system,
        messages: req.messages,
        output_config: { format: { type: "json_schema", schema: req.schema } },
      },
    );
    if (res.stop_reason === "refusal") throw new ModelError(`${req.model} declined this request.`);
    const text = (res.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ModelError(`${req.model} returned non-JSON (stop_reason ${res.stop_reason}): ${text.slice(0, 200)}`);
    }
  },
};
