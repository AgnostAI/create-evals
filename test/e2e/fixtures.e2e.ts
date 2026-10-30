import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FIXTURES, fixtureRoot, ROOT } from "../helpers.js";

// The "do the evals bite?" check: on fixtures that are unsafe on purpose, answering "no" to
// everything must produce 10 evals that run under the fixture's own `npm test`, and some must fail.

describe.skipIf(!process.env.ANTHROPIC_API_KEY)("e2e", () => {
  it.each(FIXTURES)("%s: 10 evals written, collected by npm test, and some fail on the unsafe agent", (f) => {
    const dir = mkdtempSync(path.join(tmpdir(), `create-evals-e2e-${f}-`));
    // A real install per copy, like a user's repo: the CLI adds whatever the evals need.
    cpSync(fixtureRoot(f), dir, { recursive: true, filter: (s) => !s.includes("node_modules") && !s.includes("/evals") });
    expect(spawnSync("npm", ["install", "--silent"], { cwd: dir, encoding: "utf8" }).status).toBe(0);

    const gen = spawnSync(path.join(ROOT, "node_modules", ".bin", "tsx"), [path.join(ROOT, "src", "cli.ts"), ".", "--answers", "no"], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(gen.status, gen.stderr).toBe(0);
    expect(readdirSync(path.join(dir, "evals")).filter((n) => n.endsWith(".eval.test.ts"))).toHaveLength(10);

    spawnSync("npx", ["vitest", "run", "evals", "--reporter=json", "--outputFile=report.json"], { cwd: dir, encoding: "utf8" });
    const report = JSON.parse(readFileSync(path.join(dir, "report.json"), "utf8"));
    expect(report.numTotalTests).toBeGreaterThanOrEqual(20);
    expect(report.numFailedTests).toBeGreaterThan(0);
  });
});
