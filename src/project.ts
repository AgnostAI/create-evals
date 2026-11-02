import { existsSync, readFileSync, realpathSync } from "node:fs";
import { register } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentDefinition } from "./agent.js";
import { guardNetwork, shiftClock } from "./sandbox.js";

/** `evals/create-evals.json`: how to run the agent safely. Everything is optional. */
export interface Config {
  /** The binding file. Default `evals/agent.ts`. */
  agent?: string;
  /** Pin the clock's start, e.g. "2026-11-02T09:00:00+05:30". */
  now?: string;
  /** Swap modules for fakes: { "src/google.ts": "evals/fakes/google.ts" } (repo-relative). */
  replace?: Record<string, string>;
  /** Hosts the agent may reach besides model APIs. "*.example.com" matches subdomains; add "localhost" for local sandboxes. */
  allowHosts?: string[];
  /** Env vars set before the agent loads (they win over .env and the shell). "${OTHER}" references another variable. */
  env?: Record<string, string>;
  /** Conversations at once. Default 4; use 1 if the binding shares state across conversations. */
  concurrency?: number;
  /** Override the models create-evals uses. */
  models?: { user?: string; review?: string; group?: string; judge?: string };
}

export const DIR = ".create-evals";
export const CONFIG_PATH = "evals/create-evals.json";

export function loadConfig(root: string): Config {
  const file = path.join(root, CONFIG_PATH);
  if (!existsSync(file)) return {};
  return JSON.parse(readFileSync(file, "utf8")) as Config;
}

let prepared = false;

/** Set up the sandbox, then make TypeScript and module replacement work. Must run before the agent loads. */
export async function prepare(root: string, config: Config) {
  if (prepared) return;
  prepared = true;
  const envFile = path.join(root, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  // "${OTHER_VAR}" in a value is replaced with that variable, e.g. "OPENAI_API_KEY": "${ANTHROPIC_API_KEY}".
  for (const [k, v] of Object.entries(config.env ?? {})) process.env[k] = String(v).replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? "");
  const models = config.models ?? {};
  for (const [role, id] of Object.entries(models)) if (id) process.env[`CREATE_EVALS_${role.toUpperCase()}_MODEL`] ??= id;
  guardNetwork(config.allowHosts);
  if (config.now) shiftClock(config.now);

  const { register: registerTsx } = await import("tsx/esm/api");
  registerTsx();
  const map: Record<string, string> = {};
  for (const [real, fake] of Object.entries(config.replace ?? {})) {
    for (const p of [real, fake]) if (!existsSync(path.join(root, p))) throw new Error(`${CONFIG_PATH}: "replace" points at ${p}, which doesn't exist.`);
    // Real paths on both sides: imports resolve through symlinks (monorepos, pnpm), so the keys must too.
    map[pathToFileURL(realpathSync(path.join(root, real))).href] = pathToFileURL(realpathSync(path.join(root, fake))).href;
  }
  if (Object.keys(map).length) {
    const here = new URL(".", import.meta.url);
    const hooks = ["hooks.js", "hooks.ts"].map((f) => new URL(f, here)).find((u) => existsSync(u));
    // module.register() is deprecated in favor of registerHooks(), but tsx's async hooks need it to chain.
    const emit = process.emitWarning;
    process.emitWarning = ((w: any, ...rest: any[]) => (String(rest[1] ?? rest[0]?.code ?? "").includes("DEP0205") ? undefined : (emit as any).call(process, w, ...rest))) as typeof process.emitWarning;
    register(hooks!.href, { data: { map } });
    process.emitWarning = emit;
  }
}

export async function loadAgent(root: string, config: Config): Promise<AgentDefinition> {
  const file = path.join(root, config.agent ?? "evals/agent.ts");
  if (!existsSync(file)) throw new Error(`No ${path.relative(root, file)} yet. Run \`create-evals init\` and fill it in (see the skill).`);
  const mod = await import(pathToFileURL(file).href);
  const agent = (mod.default ?? mod.agent) as AgentDefinition | undefined;
  if (!agent?.start) throw new Error(`${path.relative(root, file)} must \`export default defineAgent({ ... })\`.`);
  return agent;
}

/** The agent's instructions as text, for the reviewer: file contents (with their paths) or literal text. */
export function readInstructions(root: string, agent: AgentDefinition): string {
  const parts = (agent.instructions ?? []).map((item) => {
    const file = path.join(root, item);
    return existsSync(file) ? `--- ${item} ---\n${readFileSync(file, "utf8")}` : item;
  });
  const text = parts.join("\n\n");
  return text.length > 60_000 ? `${text.slice(0, 60_000)}\n…(truncated)` : text;
}
