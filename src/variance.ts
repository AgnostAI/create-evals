import { parseJson } from "./run.js";
import type { FailureMode, Trace } from "./types.js";

/** One input that ran more than once and didn't get the same answer every time. */
export interface Variance {
  agent: string;
  profile: string;
  runs: number;
  /** Decision fields whose value changed between runs, with how often each value came up. Strongest first. */
  fields: { field: string; kind: FieldKind; values: [value: string, count: number][] }[];
  /** A real decision flipped: a field named in `decisions`, or (without them) a yes/no or status-like field outside a list. */
  strong: boolean;
  /** Reviewed runs, and how many of them had problems (only when some did and some didn't). */
  reviewed?: number;
  withProblems?: number;
}

/**
 * "declared": named in the binding's `decisions`. Otherwise judged by shape: "boolean"; "enum", a status-like
 * identifier ("qualified", "not_relevant"); "label", other short text; "number"; "list", a list of labels.
 */
export type FieldKind = "declared" | "boolean" | "enum" | "label" | "number" | "list";

/** Every leaf of an output by path. Lists of plain values are one leaf (order aside); lists of objects are walked. */
export function leaves(value: unknown, prefix = "", out: Record<string, unknown> = {}, depth = 0): Record<string, unknown> {
  const at = prefix || "output";
  if (value === null || typeof value !== "object") out[at] = value;
  else if (Array.isArray(value)) {
    if (value.every((v) => v === null || typeof v !== "object")) out[at] = value.map(String).sort();
    else if (depth < 4) value.slice(0, 20).forEach((v, i) => leaves(v, `${at}[${i}]`, out, depth + 1));
  } else if (depth < 4) {
    for (const [k, v] of Object.entries(value)) leaves(v, prefix ? `${prefix}.${k}` : k, out, depth + 1);
  }
  return out;
}

/** A short label ("qualified", "Series B", "high"), as opposed to free text that rewords itself every run, or a URL. */
const isLabel = (s: string) => s.length <= 30 && !s.includes("\n") && !/:\/\/|^www\.|\//.test(s) && s.trim().split(/\s+/).length <= 3;

function kindOf(v: unknown): FieldKind | undefined {
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "number") return "number";
  if (typeof v === "string") return /^[a-z][a-z0-9_-]{0,29}$/.test(v) ? "enum" : isLabel(v) ? "label" : undefined;
  if (Array.isArray(v)) return v.every((x) => isLabel(String(x))) && v.length <= 8 ? "list" : undefined;
  return undefined;
}

/** Of the kinds seen across runs (null counts as any), the one a field is, or undefined if it's free text. */
function fieldKind(values: unknown[]): FieldKind | undefined {
  const kinds = new Set(values.filter((v) => v !== null).map(kindOf));
  if (kinds.has(undefined)) return undefined;
  if (kinds.size === 0) return "enum";
  if (kinds.size === 1) return [...kinds][0];
  // "qualified" in one run, "Qualified (pending)" in another: still a short label.
  return [...kinds].every((k) => k === "enum" || k === "label") ? "label" : undefined;
}

/** "status", "is_*", "people[].keep": matched against the whole path or its last key, ignoring list indexes. */
export function matches(field: string, patterns: string[]): boolean {
  const plain = field.replace(/\[\d+\]/g, "[]");
  const last = plain.split(".").at(-1)!.replace(/\[\]$/, "");
  return patterns.some((p) => {
    const re = new RegExp(`^${p.replace(/[.+?^${}()|\\]/g, "\\$&").replace(/\[\]/g, "\\[\\]").replace(/\*/g, ".*")}$`);
    return re.test(plain) || re.test(last);
  });
}

/** What a function run produced: its state (or JSON reply), by path. A crash is its own outcome. */
function outcome(t: Trace): Record<string, unknown> {
  if (t.ended === "agent-error") return { outcome: "crashed" };
  const reply = t.turns.findLast((x) => x.role === "agent")?.text ?? "";
  return leaves(t.state ?? parseJson(reply) ?? reply);
}

const RANK: Record<FieldKind, number> = { declared: 0, boolean: 1, enum: 2, label: 3, number: 4, list: 5 };

/** A decision, as opposed to a detail that moved: declared, or a yes/no or status outside a list (not people[2].x). */
const isStrong = (f: { field: string; kind: FieldKind }) => f.kind === "declared" || ((f.kind === "boolean" || f.kind === "enum") && !f.field.includes("["));

/**
 * Inputs that ran several times and got different answers (function agents) or mixed reviews (any agent).
 * `decisions` maps an agent to the fields it decides; then only those count. Without it, yes/no fields,
 * short labels and numbers count, and free text (reasons, wording) never does.
 */
export function variance(traces: Trace[], decisions: Record<string, string[] | undefined> = {}): Variance[] {
  const byInput = new Map<string, Trace[]>();
  for (const t of traces) {
    if (t.ended === "user-error") continue;
    const key = `${t.agent}\u0000${t.profile.id}`;
    byInput.set(key, [...(byInput.get(key) ?? []), t]);
  }
  const out: Variance[] = [];
  for (const runs of byInput.values()) {
    if (runs.length < 2) continue;
    const agent = runs[0]!.agent;
    const declared = decisions[agent];
    const v: Variance = { agent, profile: runs[0]!.profile.id, runs: runs.length, fields: [], strong: false };
    if (runs[0]!.profile.input !== undefined) {
      const maps = runs.map(outcome);
      for (const field of new Set(maps.flatMap((m) => Object.keys(m)))) {
        const present = maps.filter((m) => field in m).map((m) => m[field]);
        let kind: FieldKind | undefined;
        if (field === "outcome") kind = "declared";
        else if (declared) kind = matches(field, declared) ? "declared" : undefined;
        // A field counts only if it's decision-shaped in every run; one free-text value makes it free text.
        else kind = fieldKind(present);
        if (!kind) continue;
        const counts = new Map<string, number>();
        for (const m of maps) {
          const val = !(field in m) ? "(missing)" : Array.isArray(m[field]) ? `[${(m[field] as string[]).join(", ")}]` : String(m[field]);
          counts.set(val, (counts.get(val) ?? 0) + 1);
        }
        if (counts.size > 1) v.fields.push({ field, kind, values: [...counts].sort((a, b) => b[1] - a[1]) });
      }
      v.fields.sort((a, b) => Number(isStrong(b)) - Number(isStrong(a)) || RANK[a.kind] - RANK[b.kind]);
      v.strong = v.fields.some(isStrong);
    }
    const reviewed = runs.filter((t) => t.review);
    const bad = reviewed.filter((t) => t.review!.problems.length).length;
    if (reviewed.length > 1 && bad > 0 && bad < reviewed.length) Object.assign(v, { reviewed: reviewed.length, withProblems: bad });
    if (v.fields.length || v.withProblems) out.push(v);
  }
  return out.sort((a, b) => Number(b.strong) - Number(a.strong) || RANK[a.fields[0]?.kind ?? "number"] - RANK[b.fields[0]?.kind ?? "number"]);
}

/** "qualified: true 2/3, false 1/3" for the first few fields that flipped. */
export function describe(v: Variance, maxFields = 3): string {
  // For a real flip, show the decisions that flipped, not the details that moved with them.
  const shown = v.strong ? v.fields.filter(isStrong) : v.fields;
  const parts = shown.slice(0, maxFields).map((f) => `${f.field}: ${f.values.map(([val, n]) => `${val} ${n}/${v.runs}`).join(", ")}`);
  if (v.fields.length > Math.min(shown.length, maxFields)) parts.push(`+${v.fields.length - Math.min(shown.length, maxFields)} more field(s)`);
  if (v.withProblems) parts.push(`reviewer found problems in ${v.withProblems}/${v.reviewed} runs`);
  return parts.join("; ");
}

/**
 * How often a failure mode happens per input that ran more than once: "2 of 3 runs of acme".
 * A mode that shows up in only some runs of the same input is a coin flip, not a bug that reproduces every time.
 */
export function modeRates(mode: FailureMode, traces: Trace[]): string[] {
  const byId = new Map(traces.map((t) => [t.id, t]));
  const inMode = new Map<string, number>();
  for (const id of mode.traces) {
    const t = byId.get(id);
    if (t) inMode.set(t.profile.id, (inMode.get(t.profile.id) ?? 0) + 1);
  }
  const out: string[] = [];
  for (const [profile, n] of inMode) {
    const total = traces.filter((t) => t.profile.id === profile && t.review).length;
    if (total > 1) out.push(`${n} of ${total} runs of ${profile}`);
  }
  return out;
}
