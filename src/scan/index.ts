import { existsSync } from "node:fs";
import path from "node:path";
import type { AgentModel, Framework, TestRunner } from "../core/types.js";
import { mastra } from "./adapters/mastra.js";
import { openaiAgents } from "./adapters/openai-agents.js";
import type { Adapter } from "./adapters/types.js";
import { vercelAi } from "./adapters/vercel-ai.js";
import { loadProject, readJson } from "./project.js";

export const ADAPTERS: Adapter[] = [mastra, openaiAgents, vercelAi];

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

export class ScanError extends Error {}

export function scan(root: string): AgentModel {
  const pkg = readJson<PackageJson>(path.join(root, "package.json"));
  if (!pkg) throw new ScanError(`No package.json in ${root}. Run create-evals from the root of a TypeScript agent repo.`);
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };

  const ctx = loadProject(root);
  // Several frameworks can coexist (e.g. Mastra apps also depend on AI SDK providers).
  // The one that defines the most tools wins.
  const results = ADAPTERS.filter((a) => a.packages.some((p) => p in deps)).map((a) => ({ adapter: a, ...a.scan(ctx) }));
  const best = results.sort((a, b) => b.tools.length - a.tools.length)[0];
  if (!best || best.tools.length === 0) {
    throw new ScanError(
      "Couldn't find any agent tools. create-evals v1 supports the Vercel AI SDK (`tool()`), OpenAI Agents SDK (`tool()`), and Mastra (`createTool()`).",
    );
  }

  const prompts = best.agents.flatMap((a) => (a.prompt ? [a.prompt] : []));
  const modelText = best.agents.map((a) => a.model ?? "").join(" ");

  return {
    root,
    framework: best.adapter.framework,
    runner: detectRunner(pkg),
    importExtension: detectImportExtension(ctx.files.map((f) => f.getText())),
    packageManager: detectPackageManager(root),
    dependencies: deps,
    agents: best.agents,
    tools: best.tools,
    prompts,
    providerEnv: providerEnv(best.adapter.framework, modelText),
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

function providerEnv(framework: Framework, model: string): string {
  if (/anthropic|claude/i.test(model)) return "ANTHROPIC_API_KEY";
  if (/google|gemini/i.test(model)) return "GOOGLE_GENERATIVE_AI_API_KEY";
  if (/openai|gpt-|o\d/i.test(model)) return "OPENAI_API_KEY";
  return framework === "openai-agents" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
}
