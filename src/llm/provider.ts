import { generateText, Output, type LanguageModel } from "ai";
import type { z } from "zod";

export const DEFAULT_MODEL = "anthropic:claude-opus-5-5";

export interface LLM {
  label: string;
  model: LanguageModel;
  providerOptions: Record<string, Record<string, string>>;
  envVar: string;
}

const ENV: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
};

export class LLMSetupError extends Error {}

/**
 * `provider:model`, e.g. `anthropic:claude-opus-5-5` or `openai:gpt-5.5`. Any AI SDK provider
 * works if its package (`@ai-sdk/<provider>`) is installed alongside create-evals.
 */
export async function getLLM(spec = process.env.CREATE_EVALS_MODEL ?? DEFAULT_MODEL): Promise<LLM> {
  const [provider, ...rest] = spec.split(":");
  const modelId = rest.join(":");
  if (!provider || !modelId) throw new LLMSetupError(`--model must look like provider:model (got "${spec}")`);
  const envVar = ENV[provider] ?? `${provider.toUpperCase()}_API_KEY`;
  if (!process.env[envVar]) {
    throw new LLMSetupError(
      `${envVar} isn't set. create-evals uses your own key to write questions and evals.\n` +
        `  export ${envVar}=...    or use the create-evals skill inside Claude Code / Codex / Cursor (no key needed).`,
    );
  }
  let mod: Record<string, unknown>;
  try {
    mod = await import(`@ai-sdk/${provider}`);
  } catch {
    throw new LLMSetupError(`Provider "${provider}" needs @ai-sdk/${provider}: npm i -g @ai-sdk/${provider}`);
  }
  const factory = mod[provider] as ((id: string) => LanguageModel) | undefined;
  if (typeof factory !== "function") throw new LLMSetupError(`@ai-sdk/${provider} doesn't export "${provider}"`);

  return {
    label: spec,
    model: factory(modelId),
    envVar,
    // Opus 5.5 rejects sampling params and forced tool choice; native structured output is the reliable path.
    providerOptions: provider === "anthropic" ? { anthropic: { structuredOutputMode: "outputFormat", effort: "medium" } } : {},
  };
}

export async function askObject<S extends z.ZodType>(llm: LLM, schema: S, system: string, prompt: string): Promise<z.infer<S>> {
  const { output } = await generateText({
    model: llm.model,
    providerOptions: llm.providerOptions,
    output: Output.object({ schema }),
    system,
    prompt,
    maxRetries: 3,
  });
  return output as z.infer<S>;
}

/** Run `fn` over `items` with at most `limit` in flight. */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!, i);
      }
    }),
  );
  return out;
}
