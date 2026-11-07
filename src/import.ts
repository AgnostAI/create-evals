import { readFileSync } from "node:fs";
import type { Profile } from "./types.js";

/**
 * Records from a JSONL, JSON (an array, or an object holding one) or CSV file; "-" reads JSONL or JSON from stdin,
 * so a converter in any language can pipe in: `python convert.py | create-evals import -`.
 */
export function readRecords(file: string): unknown[] {
  const text = readFileSync(file === "-" ? 0 : file, "utf8").replace(/^﻿/, "");
  if (/\.csv$/i.test(file)) return parseCsv(text);
  const trimmed = text.trim();
  if (/\.jsonl$/i.test(file) || (!trimmed.startsWith("[") && /}\s*\n\s*{/.test(trimmed))) {
    return trimmed.split("\n").filter((l) => l.trim()).map((l, i) => {
      try {
        return JSON.parse(l);
      } catch {
        throw new Error(`${file}, line ${i + 1}: not JSON`);
      }
    });
  }
  const data = JSON.parse(trimmed);
  if (Array.isArray(data)) return data;
  const list = Object.values(data ?? {}).find(Array.isArray);
  if (!list) throw new Error(`${file}: expected an array of records (or an object holding one).`);
  return list;
}

/** CSV with a header row; quoted fields may hold commas, quotes ("") and newlines. Cells that look like JSON are parsed. */
export function parseCsv(text: string): Record<string, unknown>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") row.push(cell), (cell = "");
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell), rows.push(row), (row = []), (cell = "");
    } else cell += ch;
  }
  if (cell || row.length) row.push(cell), rows.push(row);
  const [header, ...body] = rows.filter((r) => r.some((c) => c.trim()));
  if (!header) return [];
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), cellValue(r[i] ?? "")])));
}

function cellValue(s: string): unknown {
  const t = s.trim();
  if (/^[[{]/.test(t)) {
    try {
      return JSON.parse(t);
    } catch {
      // not JSON after all
    }
  }
  return s;
}

/** A dotted path into a record: "payload.company". */
function get(record: unknown, field: string): unknown {
  return field.split(".").reduce<any>((v, k) => (v == null ? undefined : v[k]), record);
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);

/** The user's side of a logged conversation, if the record is one. */
function userMessages(record: any): string[] | undefined {
  const list = [record?.messages, record?.conversation, record?.turns].find(Array.isArray);
  if (!list) return undefined;
  const texts = list
    .filter((m: any) => ["user", "human", "customer"].includes(String(m?.role ?? m?.from ?? m?.speaker ?? "").toLowerCase()))
    .map((m: any) => (typeof m.content === "string" ? m.content : typeof m.text === "string" ? m.text : Array.isArray(m.content) ? m.content.map((c: any) => c?.text ?? "").join("") : ""))
    .filter((t: string) => t.trim());
  return texts.length ? texts : undefined;
}

export interface ImportOptions {
  /** Which agent these records are for, when the binding defines several. */
  agent?: string;
  /** Field holding the input (dotted path). Default: the whole record. */
  inputField?: string;
  /** Field to name profiles by (dotted path). Default: the first of id, key, domain, name, conversation_id. */
  idField?: string;
  /** "chat" replays logged user messages as a persona; "function" sends the input as is. Default: chat if records hold messages. */
  kind?: "chat" | "function";
  limit?: number;
}

/** Real records → profiles: production inputs replayed against the agent, instead of invented ones. */
export function toProfiles(records: unknown[], opts: ImportOptions = {}): Profile[] {
  const used = new Set<string>();
  const out: Profile[] = [];
  for (const [i, record] of records.slice(0, opts.limit ?? records.length).entries()) {
    const named = opts.idField ? get(record, opts.idField) : ["id", "key", "domain", "name", "conversation_id"].map((f) => get(record, f)).find((v) => typeof v === "string" || typeof v === "number");
    const first = `real-${slug(String(named ?? "")) || i + 1}`;
    let id = first;
    for (let n = 2; used.has(id); n++) id = `${first}-${n}`;
    used.add(id);
    const base: Profile = { id, ...(opts.agent ? { agent: opts.agent } : {}) };
    const said = opts.kind === "function" ? undefined : userMessages(opts.inputField ? get(record, opts.inputField) : record);
    if (said) {
      out.push({
        ...base,
        opening: said[0],
        persona: `You're a real user of this agent. In production you sent these messages, in this order:\n${said.map((m, j) => `${j + 1}. ${m}`).join("\n")}\nPursue the same goal the same way. Answer the agent's questions consistently with these messages, and don't invent details beyond them; if asked something they don't cover, say you don't know. Stop when your goal is met or you'd give up.`,
        maxTurns: Math.min(12, Math.max(4, said.length + 2)),
      });
    } else {
      const input = opts.inputField ? get(record, opts.inputField) : record;
      if (input === undefined) throw new Error(`Record ${i + 1} has no field "${opts.inputField}".`);
      out.push({ ...base, input });
    }
  }
  return out;
}
