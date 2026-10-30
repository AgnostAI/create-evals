import pc from "picocolors";

export interface CardStats {
  tools: number;
  /** What `tools` counts: "tools" or "LLM functions". */
  noun?: string;
  unguardedLabel?: string;
  unguarded: number;
  evals: number;
  files: string[];
  runCommand: string;
  envVar: string;
  hasKey: boolean;
}

const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

export function renderCard(s: CardStats): string {
  const headline = `${pc.bold(String(s.tools))} ${s.noun ?? "tools"} scanned · ${pc.bold(pc.yellow(String(s.unguarded)))} ${s.unguardedLabel ?? "had no guardrails"} · ${pc.bold(pc.green(String(s.evals)))} evals written`;
  const lines = [
    pc.bold("create-evals"),
    "",
    headline,
    "",
    ...s.files.map((f) => pc.dim(f)),
    "",
    `Run them: ${pc.cyan(s.runCommand)}${s.hasKey ? "" : pc.dim(`  (needs ${s.envVar})`)}`,
  ];
  const width = Math.min(Math.max(...lines.map((l) => visible(l).length)) + 4, 100);
  const row = (l: string) => {
    const v = visible(l);
    const text = v.length > width - 4 ? l.slice(0, width - 5) + "…" : l;
    return `${pc.dim("│")} ${text}${" ".repeat(Math.max(0, width - 4 - visible(text).length))} ${pc.dim("│")}`;
  };
  return [pc.dim(`┌${"─".repeat(width - 2)}┐`), ...lines.map(row), pc.dim(`└${"─".repeat(width - 2)}┘`)].join("\n");
}

export const AGNOST_LINE = "These evals are guesses about what will break. Agnost writes them from what actually broke in production → agnost.ai";
