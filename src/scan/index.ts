import { existsSync } from "node:fs";
import path from "node:path";
import type { AgentModel, Framework, TestRunner } from "../core/types.js";
import { llmSdk } from "./adapters/llm-sdk.js";
import { mastra } from "./adapters/mastra.js";
import { openaiAgents } from "./adapters/openai-agents.js";
import type { Adapter } from "./adapters/types.js";
import { vercelAi } from "./adapters/vercel-ai.js";
import { loadProject, readJson } from "./project.js";

// Order matters for ties: framework adapters before the raw-SDK fallback.
export const ADAPTERS: Adapter[] = [mastra, openaiAgents, vercelAi, llmSdk];

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

export class ScanError extends Error {}

/**
 * Repo facts that don't depend on recognizing the agent: package manager, test runner, import
 * style. Used when the host agent maps the agent itself.
 */
export function repoBase(root: string): AgentModel {
  const pkg = readJson<PackageJson>(path.join(root, "package.json"));
  if (!pkg) throw new ScanError(`No package.json in ${root}. Run create-evals from the root of a TypeScript agent repo.`);
  const ctx = loadProject(root);
  return {
    root,
    framework: "custom",
    runner: detectRunner(pkg),
    importExtension: detectImportExtension(ctx.files.map((f) => f.getText())),
    packageManager: detectPackageManager(root),
    dependencies: { ...pkg.dependencies, ...pkg.devDependencies },
    agents: [],
    tools: [],
    prompts: [],
    providerEnv: providerEnv("custom", "", { ...pkg.dependencies, ...pkg.devDependencies }),
  };
}

export function scan(root: string): AgentModel {
  const pkg = readJson<PackageJson>(path.join(root, "package.json"));
  if (!pkg) throw new ScanError(`No package.json in ${root}. Run create-evals from the root of a TypeScript agent repo.`);
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };

  const ctx = loadProject(root);
  // Several frameworks can coexist (e.g. Mastra apps also depend on AI SDK providers).
  // The one that defines the most tools wins.
  // A tool-calling agent beats a bare LLM function when both exist.
  const results = ADAPTERS.filter((a) => a.packages.some((p) => p in deps)).map((a) => ({ adapter: a, ...a.scan(ctx) }));
  const weight = (r: (typeof results)[number]) => r.tools.length * 10 + r.agents.filter((x) => x.entry && x.prompt).length;
  const best = results.sort((a, b) => weight(b) - weight(a))[0];
  if (!best || weight(best) === 0) {
    const skipped = results.flatMap((r) => r.skipped ?? []);
    const why = skipped.length
      ? `\n\nLLM calls it found but couldn't use:\n${skipped
          .slice(0, 5)
          .map((x) => `  ${x.loc.file}:${x.loc.line} — ${x.reason}`)
          .join("\n")}${skipped.length > 5 ? `\n  … and ${skipped.length - 5} more` : ""}`
      : "";
    throw new ScanError(
      `Couldn't find an agent. create-evals supports tool-calling agents on the Vercel AI SDK, OpenAI Agents SDK, and Mastra, and exported functions that call an LLM (openai, @anthropic-ai/sdk, or the AI SDK) with a system prompt written in the code.${why}`,
    );
  }

  const framework = best.agents[0]?.framework ?? best.adapter.framework;
  const prompts = best.agents.flatMap((a) => (a.prompt ? [a.prompt] : []));
  const modelText = best.agents.map((a) => a.model ?? "").join(" ");

  return {
    root,
    framework,
    runner: detectRunner(pkg),
    importExtension: detectImportExtension(ctx.files.map((f) => f.getText())),
    packageManager: detectPackageManager(root),
    dependencies: deps,
    agents: best.agents.filter((a) => a.entry?.kind !== "llm-function" || a.prompt),
    // Factories can produce several tools under one name (one per provider); keep the first.
    tools: best.tools.filter((t, i, all) => all.findIndex((u) => u.name === t.name) === i),
    prompts,
    providerEnv: providerEnv(framework, modelText, deps),
  };
}

function detectRunner(pkg: PackageJson): TestRunner | null {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const test = pkg.scripts?.test ?? "";
  if ("vitest" in deps || /\bvitest\b/.test(test)) return "vitest";
  if ("jest" in deps || /\bjest\b/.test(test)) return "jest";
  return null;
}

function detectImportExtension(sources: string[]): ".js" | "" {
  let withExt = 0;
  let without = 0;
  for (const src of sources) {
    for (const m of src.matchAll(/from\s+["'](\.{1,2}\/[^"']+)["']/g)) {
      if (/\.(js|mjs|ts)$/.test(m[1]!)) withExt++;
      else without++;
    }
  }
  return withExt > without ? ".js" : "";
}

function detectPackageManager(root: string): AgentModel["packageManager"] {
  if (existsSync(path.join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(path.join(root, "yarn.lock"))) return "yarn";
  if (existsSync(path.join(root, "bun.lockb")) || existsSync(path.join(root, "bun.lock"))) return "bun";
  return "npm";
}

function providerEnv(framework: Framework, model: string, deps: Record<string, string> = {}): string {
  if (framework === "openai-sdk") return "OPENAI_API_KEY";
  if (framework === "anthropic-sdk") return "ANTHROPIC_API_KEY";
  if (/anthropic|claude/i.test(model)) return "ANTHROPIC_API_KEY";
  if (/google|gemini/i.test(model)) return "GOOGLE_GENERATIVE_AI_API_KEY";
  if (/openai|gpt-|o\d/i.test(model)) return "OPENAI_API_KEY";
  // Model built elsewhere (createOpenAI(), a config file): go by which provider package is installed.
  const has = (p: string) => p in deps;
  if (has("@ai-sdk/openai") && !has("@ai-sdk/anthropic")) return "OPENAI_API_KEY";
  if (has("@ai-sdk/google") && !has("@ai-sdk/anthropic")) return "GOOGLE_GENERATIVE_AI_API_KEY";
  if (has("openai") && !has("@anthropic-ai/sdk") && !has("@ai-sdk/anthropic")) return "OPENAI_API_KEY";
  return framework === "openai-agents" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
}
