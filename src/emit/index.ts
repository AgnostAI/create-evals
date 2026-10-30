import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AgentModel, AnsweredQuestion, EvalSpec, TestRunner } from "../core/types.js";
import { evalFileName, renderEval, renderJudge, renderRepeat } from "./eval-file.js";
import { renderHarness } from "./harness.js";

/** Versions we generate code against. */
const DEP_VERSIONS: Record<string, string> = {
  vitest: "^5.0.5",
  "@anthropic-ai/sdk": "^1.3.0",
};

export interface EmitOptions {
  outDir?: string;
  /** Overwrite harness.ts / judge.ts even if they exist (they're meant to be hand-edited). */
  force?: boolean;
  questions?: AnsweredQuestion[];
}

export interface EmitResult {
  dir: string;
  runner: TestRunner;
  files: string[];
  kept: string[];
  removed: string[];
  addedDeps: string[];
  addedTestScript: boolean;
}

export function emit(model: AgentModel, specs: EvalSpec[], opts: EmitOptions = {}): EmitResult {
  const runner = model.runner ?? "vitest";
  const rel = opts.outDir ?? "evals";
  const dir = path.join(model.root, rel);
  mkdirSync(dir, { recursive: true });
  const files: string[] = [];
  const kept: string[] = [];
  const removed: string[] = [];

  const write = (name: string, content: string, preserve = false) => {
    const target = path.join(dir, name);
    if (preserve && existsSync(target) && !opts.force) {
      kept.push(`${rel}/${name}`);
      return;
    }
    writeFileSync(target, content);
    files.push(`${rel}/${name}`);
  };

  write("harness.ts", renderHarness(model), true);
  const usesJudge = specs.some((s) => s.cases.some((c) => c.expect.some((a) => a.type === "judge")));
  if (usesJudge) write("judge.ts", renderJudge(model), true);
  if (specs.some((s) => s.cases.some((c) => c.repeat))) write("repeat.ts", renderRepeat());
  const current = new Set(specs.map((spec, i) => evalFileName(spec, i)));
  // Re-emitting renumbers files; drop earlier generated evals that are no longer in the spec set.
  for (const name of readdirSync(dir)) {
    if (!/^\d{2}-.*\.eval\.test\.ts$/.test(name) || current.has(name)) continue;
    if (readFileSync(path.join(dir, name), "utf8").startsWith("// create-evals ·")) {
      unlinkSync(path.join(dir, name));
      removed.push(`${rel}/${name}`);
    }
  }
  specs.forEach((spec, i) => write(evalFileName(spec, i), renderEval(spec, model, runner)));
  write(
    "create-evals.json",
    JSON.stringify(
      {
        $comment:
          "Written by create-evals: the questions you answered and the eval specs they became. Edit a spec and run `npx create-evals emit evals/create-evals.json` to re-render the tests.",
        generatedAt: new Date().toISOString(),
        framework: model.framework,
        evals: specs.map((s, i) => ({
          file: evalFileName(s, i),
          question: s.question,
          answer: s.answer,
          citation: `${s.citation.file}:${s.citation.line}`,
          finding: opts.questions?.find((q) => q.id === s.questionId)?.findingId,
        })),
        specs,
      },
      null,
      2,
    ) + "\n",
  );

  const { addedDeps, addedTestScript } = patchPackageJson(model, runner, usesJudge);
  return { dir: rel, runner, files, kept, removed, addedDeps, addedTestScript };
}

function patchPackageJson(model: AgentModel, runner: TestRunner, usesJudge: boolean) {
  const file = path.join(model.root, "package.json");
  const raw = readFileSync(file, "utf8");
  const pkg = JSON.parse(raw) as { scripts?: Record<string, string>; devDependencies?: Record<string, string> };
  const has = (d: string) => d in model.dependencies;

  const needed = [
    ...(runner === "vitest" && !has("vitest") ? ["vitest"] : []),
    ...(usesJudge && !has("@anthropic-ai/sdk") ? ["@anthropic-ai/sdk"] : []),
  ];
  pkg.devDependencies = { ...pkg.devDependencies };
  for (const d of needed) pkg.devDependencies[d] = DEP_VERSIONS[d]!;

  let addedTestScript = false;
  pkg.scripts = { ...pkg.scripts };
  if (!pkg.scripts.test || /no test specified/.test(pkg.scripts.test)) {
    pkg.scripts.test = runner === "vitest" ? "vitest run" : "jest";
    addedTestScript = true;
  }

  if (needed.length || addedTestScript) {
    const indent = /^(\s+)"/m.exec(raw)?.[1] ?? "  ";
    writeFileSync(file, JSON.stringify(pkg, null, indent) + "\n");
  }
  return { addedDeps: needed, addedTestScript };
}

/** Write just the harness (and judge) so the host agent can add wrappers before writing specs. */
export function emitHarness(model: AgentModel, opts: { outDir?: string; force?: boolean } = {}): { file: string; kept: boolean } {
  const rel = opts.outDir ?? "evals";
  const dir = path.join(model.root, rel);
  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, "harness.ts");
  if (existsSync(target) && !opts.force) return { file: `${rel}/harness.ts`, kept: true };
  writeFileSync(target, renderHarness(model));
  return { file: `${rel}/harness.ts`, kept: false };
}
