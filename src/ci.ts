import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * `create-evals ci`: run the evals before every commit and in CI.
 * Only evals marked `tier: "always"` (the ones that pass today) can block; known bugs are reported, never blocking.
 */

export const HOOK_COMMAND = "npx -y create-evals test --precommit";
const MARK = "# create-evals";

export interface Step {
  /** "wrote", "kept" or "todo" (something the developer or their coding agent must do by hand). */
  kind: "wrote" | "kept" | "todo";
  text: string;
}

function git(root: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

/** The repo's top folder, resolved the same way as `root` (macOS /var is a symlink to /private/var). */
function toplevel(root: string): string | undefined {
  const top = git(root, ["rev-parse", "--show-toplevel"]);
  return top && realpathSync(top);
}

/** Install the pre-commit hook, alongside whatever hook setup the repo already has. */
export function installHook(root: string): Step {
  root = realpathSync(root);
  const top = toplevel(root);
  if (!top) return { kind: "todo", text: "pre-commit hook: not a git repo, skipped" };
  const sub = path.relative(top, root);
  const cmd = sub ? `(cd "${sub.split(path.sep).join("/")}" && ${HOOK_COMMAND})` : HOOK_COMMAND;
  const block = `${MARK}: run the evals that pass today (skip once: git commit --no-verify)\n${cmd}\n`;

  for (const f of [".pre-commit-config.yaml", "lefthook.yml", "lefthook.yaml"]) {
    if (existsSync(path.join(top, f))) return { kind: "todo", text: `pre-commit hook: add \`${cmd}\` to ${f}` };
  }
  // Husky keeps hooks in .husky/, committed, so the whole team gets them.
  const husky = path.join(top, ".husky");
  const file = existsSync(husky) ? path.join(husky, "pre-commit") : path.resolve(root, git(root, ["rev-parse", "--git-path", "hooks/pre-commit"]) ?? ".git/hooks/pre-commit");
  const shown = path.relative(root, file);
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (existing.includes(MARK)) return { kind: "kept", text: `pre-commit hook (${shown})` };
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, existing ? `${existing.replace(/\n*$/, "\n\n")}${block}` : `#!/bin/sh\n${block}`);
  chmodSync(file, 0o755);
  return { kind: "wrote", text: `pre-commit hook (${shown})` };
}

/** How CI installs the agent's own dependencies, guessed from the lockfiles. The coding agent adjusts it if needed. */
function installSteps(root: string): string[] {
  const has = (f: string) => existsSync(path.join(root, f));
  const steps: string[] = [];
  if (has("pnpm-lock.yaml")) steps.push("- run: corepack enable && pnpm install --frozen-lockfile");
  else if (has("yarn.lock")) steps.push("- run: corepack enable && yarn install");
  else if (has("package-lock.json")) steps.push("- run: npm ci");
  else if (has("package.json")) steps.push("- run: npm install");
  const py = ["requirements.lock", "requirements.txt"].find(has);
  if (py || has("pyproject.toml") || has("uv.lock")) {
    const version = has(".python-version") ? readFileSync(path.join(root, ".python-version"), "utf8").trim() : "3.12";
    steps.push("- uses: actions/setup-python@v5", "  with:", `    python-version: "${version}"`);
    // Same .venv as on the developer's machine, so evals/agent.ts runs unchanged.
    if (has("uv.lock")) steps.push("- run: pip install uv && uv venv .venv && uv sync --frozen");
    else steps.push(`- run: python -m venv .venv && .venv/bin/pip install ${py ? `-r ${py}` : "."}`);
  }
  return steps;
}

export function workflow(root: string): string {
  root = realpathSync(root);
  const branch = git(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])?.replace(/^origin\//, "") || "main";
  const top = toplevel(root) ?? root;
  const sub = path.relative(top, root).split(path.sep).join("/");
  const steps = [
    "- uses: actions/checkout@v4",
    "- uses: actions/setup-node@v4",
    "  with:",
    "    node-version: 22",
    ...installSteps(root),
    "# Only evals marked always (they passed when created, or were fixed since) can fail this job.",
    "- run: npx -y create-evals test --tier always",
    "  env:",
    "    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}",
  ];
  return `name: evals
on:
  push:
    branches: [${branch}]
  pull_request:
jobs:
  evals:
    runs-on: ubuntu-latest
${sub ? `    defaults:\n      run:\n        working-directory: ${sub}\n` : ""}    steps:
${steps.map((s) => `      ${s}`).join("\n")}
`;
}

/** Write .github/workflows/evals.yml at the repo root, unless one is already there. */
export function writeWorkflow(root: string): Step {
  root = realpathSync(root);
  const top = toplevel(root) ?? root;
  const file = path.join(top, ".github", "workflows", "evals.yml");
  const shown = path.relative(root, file);
  if (existsSync(file)) return { kind: "kept", text: `CI (${shown})` };
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, workflow(root));
  return { kind: "wrote", text: `CI (${shown})` };
}
