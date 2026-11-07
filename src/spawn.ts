import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { existsSync } from "node:fs";
import type { Session } from "./agent.js";
import type { Context } from "./context.js";

const MARKER = "@@CREATE_EVALS@@";

/** Directory holding create_evals.py (the Python helper), for PYTHONPATH. */
export const pythonHelperDir = [new URL("../python/", import.meta.url), new URL("../../python/", import.meta.url)]
  .map((u) => fileURLToPath(u))
  .find((d) => existsSync(path.join(d, "create_evals.py")))!;

export interface SpawnOptions {
  cwd?: string;
  /** Extra env for the child. PYTHONPATH gets the helper prepended; CREATE_EVALS_ALLOW gets `allowHosts`. */
  env?: Record<string, string>;
  /** Hosts the child may reach besides model APIs (passed to the helper's guard()). */
  allowHosts?: string[];
}

/**
 * Run an agent in another process (Python, Go, anything) for one conversation. The child speaks a
 * line protocol: it reads `{"message", "profile"}` JSON lines on stdin and answers each with
 * `@@CREATE_EVALS@@{"reply", "events"?, "state"?, "error"?}` on stdout. `python/create_evals.py`
 * implements it for Python.
 */
export function spawnSession(ctx: Context, command: string[], opts: SpawnOptions = {}): Session {
  const [cmd, ...args] = command;
  const cwd = opts.cwd ?? process.cwd();
  // The repo itself (and src/, for src layouts) goes on the path, so `import myapp` finds this checkout's
  // code without sys.path tricks, ahead of an editable install that may point at another copy.
  const repoPaths = [cwd, path.join(cwd, "src")].filter((d) => existsSync(d));
  const child = spawn(cmd!, args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      ...opts.env,
      PYTHONPATH: [pythonHelperDir, ...repoPaths, opts.env?.PYTHONPATH ?? process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
      CREATE_EVALS_ALLOW: (opts.allowHosts ?? []).join(","),
      PYTHONUNBUFFERED: "1",
    },
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-4000)));
  const pending: ((line: string | Error) => void)[] = [];
  createInterface({ input: child.stdout }).on("line", (line) => {
    if (line.startsWith(MARKER)) pending.shift()?.(line.slice(MARKER.length));
  });
  child.on("exit", (code) => {
    for (const p of pending.splice(0)) p(new Error(`agent process exited (${code}):\n${stderr}`));
  });
  let lastState: unknown;

  return {
    send(message) {
      return new Promise((resolve, reject) => {
        pending.push((line) => {
          if (line instanceof Error) return reject(line);
          const out = JSON.parse(line) as { reply: string; events?: any[]; state?: unknown; error?: string };
          for (const e of out.events ?? []) ctx.record({ kind: e.kind ?? "tool", name: e.name, input: e.input, output: e.output });
          if (out.state !== undefined) lastState = out.state;
          if (out.error) reject(new Error(`agent error: ${out.error}`));
          else resolve(out.reply);
        });
        child.stdin.write(JSON.stringify({ message, profile: ctx.profile }) + "\n");
      });
    },
    state: () => lastState,
    close() {
      child.stdin.end();
      child.kill();
    },
  };
}
