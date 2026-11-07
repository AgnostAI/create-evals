import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** Heavy or machine-specific folders: linked into the copy, not copied (the copy runs with the same installs). */
const LINK = new Set(["node_modules", ".venv", "venv", ".tox"]);
/** Folders the copy doesn't need. */
const SKIP = new Set([".git", ".create-evals", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".next", ".turbo"]);

/** Copy the repo to a temp folder for a throwaway change. Installs are symlinked, so the copy runs as is. */
export function copyRepo(root: string): string {
  const dest = mkdtempSync(path.join(tmpdir(), "create-evals-ablate-"));
  cpSync(root, dest, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (src) => {
      const name = path.basename(src);
      if (src === root) return true;
      if (SKIP.has(name)) return false;
      if (LINK.has(name)) {
        const to = path.join(dest, path.relative(root, src));
        if (!existsSync(to)) symlinkSync(src, to, "dir");
        return false;
      }
      return true;
    },
  });
  return dest;
}

/** Delete exact text from a file in the copy (e.g. one rule from a prompt). It must appear exactly once. */
export function removeText(dir: string, file: string, text: string) {
  const target = path.join(dir, file);
  if (!existsSync(target)) throw new Error(`--in ${file}: no such file`);
  const src = readFileSync(target, "utf8");
  const at = src.indexOf(text);
  if (at < 0) throw new Error(`--remove: the text isn't in ${file} (it must match exactly, including whitespace).`);
  if (src.indexOf(text, at + 1) >= 0) throw new Error(`--remove: the text appears more than once in ${file}; quote more of it.`);
  writeFileSync(target, src.slice(0, at) + src.slice(at + text.length));
}

/** Apply a unified diff (from `git diff`) to the copy. */
export function applyPatch(dir: string, patchFile: string) {
  try {
    execFileSync("git", ["apply", "--whitespace=nowarn", path.resolve(patchFile)], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e: any) {
    throw new Error(`--patch ${patchFile} didn't apply: ${String(e.stderr ?? e.message).trim()}`);
  }
}
