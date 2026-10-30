import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyze } from "../src/pipeline.js";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const FIXTURES = ["support-agent", "coding-agent", "ops-agent", "triage-agent"] as const;
export type Fixture = (typeof FIXTURES)[number];

export const fixtureRoot = (f: Fixture) => path.join(ROOT, "fixtures", f);

const cache = new Map<Fixture, ReturnType<typeof analyze>>();
export function analysis(f: Fixture) {
  if (!cache.has(f)) cache.set(f, analyze(fixtureRoot(f)));
  return cache.get(f)!;
}

export function expected(f: Fixture): { framework: string; planted: { id: string; at: string }[]; notFlagged?: string[] } {
  return JSON.parse(readFileSync(path.join(fixtureRoot(f), "expected.json"), "utf8"));
}

/** All source text of a fixture (src/ only). */
export function sourceText(f: Fixture): string {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.ts$/.test(name)) out.push(readFileSync(p, "utf8"));
    }
  };
  walk(path.join(fixtureRoot(f), "src"));
  return out.join("\n");
}
