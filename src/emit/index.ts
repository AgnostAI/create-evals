import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AgentModel, AnsweredQuestion, EvalSpec, TestRunner } from "../core/types.js";
import { evalFileName, renderEval, renderJudge } from "./eval-file.js";
import { renderHarness } from "./harness.js";

/** Versions we generate code against. */
const DEP_VERSIONS: Record<string, string> = {
  vitest: "^5.0.5",
  ai: "^7.0.157",
  "@ai-sdk/anthropic": "^4.0.92",
  zod: "^4.6.7",
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
  return { dir: rel, runner, files, kept, addedDeps, addedTestScript };
}

function patchPackageJson(model: AgentModel, runner: TestRunner, usesJudge: boolean) {
  const file = path.join(model.root, "package.json");
  const raw = readFileSync(file, "utf8");
  const pkg = JSON.parse(raw) as { scripts?: Record<string, string>; devDependencies?: Record<string, string> };
  const has = (d: string) => d in model.dependencies;

  const needed = [
    ...(runner === "vitest" && !has("vitest") ? ["vitest"] : []),
    ...(usesJudge ? ["ai", "@ai-sdk/anthropic", "zod"].filter((d) => !has(d)) : []),
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
