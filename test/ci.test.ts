import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HOOK_COMMAND, installHook, workflow, writeWorkflow } from "../src/ci.js";

function repo(files: Record<string, string> = {}): string {
  const root = mkdtempSync(path.join(tmpdir(), "ce-ci-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  for (const [f, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    writeFileSync(path.join(root, f), content);
  }
  return root;
}

describe("installHook", () => {
  it("writes an executable git hook, and is idempotent", () => {
    const root = repo();
    expect(installHook(root).kind).toBe("wrote");
    const file = path.join(root, ".git/hooks/pre-commit");
    expect(readFileSync(file, "utf8")).toMatch(/^#!\/bin\/sh\n[\s\S]*npx -y create-evals test --precommit\n$/);
    expect(statSync(file).mode & 0o111).toBeTruthy();
    expect(installHook(root).kind).toBe("kept");
  });

  it("keeps an existing hook and appends to it", () => {
    const root = repo({ ".git/hooks/pre-commit": "#!/bin/sh\nnpm run lint\n" });
    installHook(root);
    const hook = readFileSync(path.join(root, ".git/hooks/pre-commit"), "utf8");
    expect(hook.startsWith("#!/bin/sh\nnpm run lint\n\n# create-evals")).toBe(true);
    expect(hook.match(/#!\/bin\/sh/g)).toHaveLength(1);
  });

  it("uses husky when the repo has it", () => {
    const root = repo({ ".husky/pre-commit": "npx lint-staged\n" });
    expect(installHook(root).text).toContain(".husky/pre-commit");
    expect(readFileSync(path.join(root, ".husky/pre-commit"), "utf8")).toContain(HOOK_COMMAND);
  });

  it("leaves pre-commit framework configs to the developer", () => {
    const root = repo({ ".pre-commit-config.yaml": "repos: []\n" });
    const step = installHook(root);
    expect(step.kind).toBe("todo");
    expect(step.text).toContain(".pre-commit-config.yaml");
  });

  it("cds into the agent's folder in a monorepo", () => {
    const root = repo({ "apps/bot/package.json": "{}" });
    installHook(path.join(root, "apps/bot"));
    expect(readFileSync(path.join(root, ".git/hooks/pre-commit"), "utf8")).toContain(`(cd "apps/bot" && ${HOOK_COMMAND})`);
  });
});

describe("workflow", () => {
  it("installs node deps and runs only the always evals with the key secret", () => {
    const yml = workflow(repo({ "package-lock.json": "{}" }));
    expect(yml).toContain("- run: npm ci");
    expect(yml).toContain("- run: npx -y create-evals test --tier always");
    expect(yml).toContain("ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}");
    expect(yml).toContain("branches: [main]");
  });

  it("builds the same .venv for a Python agent", () => {
    const yml = workflow(repo({ "requirements.lock": "", "pyproject.toml": "", ".python-version": "3.11\n" }));
    expect(yml).toContain('python-version: "3.11"');
    expect(yml).toContain("python -m venv .venv && .venv/bin/pip install -r requirements.lock");
  });

  it("writes it at the repo root, and never overwrites one", () => {
    const root = repo({ "apps/bot/package.json": "{}" });
    const bot = path.join(root, "apps/bot");
    expect(writeWorkflow(bot).kind).toBe("wrote");
    expect(readFileSync(path.join(root, ".github/workflows/evals.yml"), "utf8")).toContain("working-directory: apps/bot");
    expect(writeWorkflow(bot).kind).toBe("kept");
  });
});
