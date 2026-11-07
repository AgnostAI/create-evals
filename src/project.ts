import { existsSync, readFileSync, realpathSync } from "node:fs";
import * as nodeModule from "node:module";
import { register } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
  /** Env files to load (repo-relative), e.g. "backend/.env". Default ".env" if present. Later files and the shell win over earlier ones. */
  envFile?: string | string[];
  /** Env vars set before the agent loads (they win over .env and the shell). "${OTHER}" references another variable. */
  env?: Record<string, string>;
  /** Directory the agent runs in (repo-relative), for agents that open files relative to the working directory. */
  cwd?: string;
  /** Conversations at once. Default 4; use 1 if the binding shares state across conversations. */
  concurrency?: number;
  /** Override the models create-evals uses. */
  models?: { user?: string; review?: string; group?: string; judge?: string };
}

export const DIR = ".create-evals";
export const CONFIG_PATH = "evals/create-evals.json";

export function loadConfig(root: string, configPath = CONFIG_PATH): Config {
  const file = path.resolve(root, configPath);
  if (configPath !== CONFIG_PATH && !existsSync(file)) throw new Error(`--config ${configPath} not found`);
  if (!existsSync(file)) return {};
  return JSON.parse(readFileSync(file, "utf8")) as Config;
}

let prepared = false;

/** Set up the sandbox, then make TypeScript and module replacement work. Must run before the agent loads. */
export async function prepare(root: string, config: Config) {
  if (prepared) return;
  prepared = true;
  // process.loadEnvFile never overwrites a variable that's already set, so the shell wins.
  if (config.envFile === undefined) {
    if (existsSync(path.join(root, ".env"))) process.loadEnvFile(path.join(root, ".env"));
  } else {
    for (const f of [config.envFile].flat().reverse()) {
      const file = path.resolve(root, f);
      if (!existsSync(file)) throw new Error(`${CONFIG_PATH}: "envFile" points at ${f}, which doesn't exist.`);
      process.loadEnvFile(file);
    }
  }
  // "${OTHER_VAR}" in a value is replaced with that variable, e.g. "OPENAI_API_KEY": "${ANTHROPIC_API_KEY}".
  for (const [k, v] of Object.entries(config.env ?? {})) process.env[k] = String(v).replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? "");
  const models = config.models ?? {};
  for (const [role, id] of Object.entries(models)) if (id) process.env[`CREATE_EVALS_${role.toUpperCase()}_MODEL`] ??= id;
  guardNetwork(config.allowHosts);
  if (config.cwd) process.chdir(path.resolve(root, config.cwd));
  if (config.now) shiftClock(config.now);

  const { register: registerTsx } = await import("tsx/esm/api");
  registerTsx();
  resolveSelf();
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

/**
 * Zero install: if the repo doesn't have create-evals installed (a Python repo, or just `npx create-evals`),
 * `import … from "create-evals"` in evals/*.ts resolves to this copy. Works for import and require.
 */
function resolveSelf() {
  const here = new URL(".", import.meta.url);
  const self = ["index.js", "index.ts"].map((f) => new URL(f, here)).find((u) => existsSync(u))!.href;
  const cjsUrl = new URL("index.cjs", here);
  const cjs = existsSync(cjsUrl) ? fileURLToPath(cjsUrl) : undefined;
  // require() (a binding compiled as CommonJS, e.g. in a repo without package.json) goes through
  // Module._resolveFilename, which Node 22's registerHooks doesn't cover. Wrap it too: hand require() the
  // CommonJS build (dist/index.cjs), and let "./x.js" find ./x.ts.
  const Module = (nodeModule as any).Module ?? nodeModule;
  const resolveFilename = Module._resolveFilename;
  if (typeof resolveFilename === "function" && !resolveFilename.__createEvals) {
    const wrapped = function (this: unknown, request: string, ...rest: unknown[]) {
      try {
        return resolveFilename.call(this, request, ...rest);
      } catch (e) {
        if (request === "create-evals") return cjs ?? fileURLToPath(self);
        // "./agent.js" meaning ./agent.ts, as TypeScript writes it: tsx maps this, but not on this path in Node 22.
        if (/^\.{1,2}\/.*\.[cm]?js$/.test(request)) {
          try {
            return resolveFilename.call(this, request.replace(/js$/, "ts"), ...rest);
          } catch {
            // fall through to the original error
          }
        }
        throw e;
      }
    };
    (wrapped as any).__createEvals = true;
    Module._resolveFilename = wrapped;
  }
  const registerHooks = (nodeModule as any).registerHooks as undefined | ((hooks: object) => void);
  if (!registerHooks) return;
  registerHooks({
    resolve(specifier: string, context: unknown, next: (s: string, c: unknown) => { url: string }) {
      try {
        return next(specifier, context);
      } catch (e) {
        if (specifier === "create-evals") return { url: self, format: "module", shortCircuit: true };
        throw e;
      }
    },
  });
}

/** The binding's agents: one (`defineAgent`) or several (`defineAgents`, or an array). */
export async function loadAgents(root: string, config: Config): Promise<AgentDefinition[]> {
  const file = path.join(root, config.agent ?? "evals/agent.ts");
  if (!existsSync(file)) throw new Error(`No ${path.relative(root, file)} yet. Run \`create-evals init\` and fill it in (see the skill).`);
  const mod = await import(pathToFileURL(file).href);
  // Without "type": "module", tsx compiles the binding as CommonJS and the default export sits one level deeper.
  let exp = (mod.default ?? mod.agent ?? mod.agents) as any;
  if (exp && !exp.start && !Array.isArray(exp) && exp.default) exp = exp.default;
  const list: any[] = Array.isArray(exp) ? exp : [exp];
  if (!list.length || list.some((a) => typeof a?.start !== "function")) {
    throw new Error(`${path.relative(root, file)} must \`export default defineAgent({ ... })\` (or \`defineAgents({ ... })\` for several).`);
  }
  return list;
}

/** Pick the agent a profile (or --agent) names. With one agent, that's the one. */
export function pickAgent(agents: AgentDefinition[], name?: string): AgentDefinition {
  if (name) {
    const a = agents.find((x) => x.name === name);
    if (!a) throw new Error(`No agent named "${name}". The binding defines: ${agents.map((x) => x.name).join(", ")}.`);
    return a;
  }
  if (agents.length > 1) throw new Error(`The binding defines several agents (${agents.map((x) => x.name).join(", ")}): say which with "agent" in the profile, or --agent.`);
  return agents[0]!;
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
